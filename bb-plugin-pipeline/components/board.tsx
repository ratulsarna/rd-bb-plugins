import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { MachineQueue, rpcContract } from "@/lib/contract";
import { COLUMNS, COLUMN_LABELS, type Column } from "@/lib/columns";
import type { ExecutionSelection } from "@/lib/execution";
import { ownerThread } from "@/lib/card";
import type { Card, CardAttachment } from "@/lib/store";
import { AddCard } from "./add-card";
import { Icon } from "./icon";
import { PipelineCard } from "./card";
import { taskNeedsAttention } from "./task-state";
import { MachineQueueStatus } from "./machine-queue";
import type { PipelineMachine } from "@/lib/machines";

const PROJECT_KEY = "pipeline:selected-project";
const VIEW_KEY = "pipeline:view";
type TaskFilter = "open" | "attention" | "queued" | "done";
const CARD_DRAG_TYPE = "application/x-bb-pipeline-card";

interface UploadedAttachment {
  type: "localImage" | "localFile";
  path: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
}

async function upload(projectId: string, file: File): Promise<CardAttachment> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/attachments`,
    { method: "POST", body: form },
  );
  if (!response.ok) throw new Error(`Could not upload ${file.name}`);
  const value = (await response.json()) as UploadedAttachment;
  const attachment: CardAttachment = {
    path: value.path,
    filename: value.name,
    isImage: value.type === "localImage",
  };
  if (value.mimeType !== undefined) attachment.mimeType = value.mimeType;
  if (value.sizeBytes !== undefined) attachment.sizeBytes = value.sizeBytes;
  return attachment;
}

export function PipelineBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const navigate = useBbNavigate();
  const sidebar = useSidebarThreads();
  const connection = useRealtimeConnectionState();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [machines, setMachines] = useState<PipelineMachine[]>([]);
  const [view, setView] = useState<"list" | "board">(() => localStorage.getItem(VIEW_KEY) === "board" ? "board" : "list");
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [stage, setStage] = useState<Column | "all">("all");
  const [cards, setCards] = useState<Awaited<ReturnType<typeof rpc.call<"listCards">>>["cards"]>([]);
  const [queue, setQueue] = useState<MachineQueue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ cardId: string; message: string } | null>(null);
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<Column | null>(null);
  const [pendingCards, setPendingCards] = useState<Set<string>>(new Set());
  const requestSequence = useRef(0);
  const projectIdRef = useRef<string | null>(null);
  const includeDoneRef = useRef(false);
  const contextProjectIdRef = useRef(context.projectId);
  contextProjectIdRef.current = context.projectId;

  const load = useCallback(async () => {
    const request = ++requestSequence.current;
    setLoading(true);
    try {
      const { projects: nextProjects } = await rpc.call("listProjects");
      if (request !== requestSequence.current) return;

      const current = projectIdRef.current;
      const remembered = localStorage.getItem(PROJECT_KEY);
      const preferred = current ?? remembered ?? contextProjectIdRef.current;
      const selected = nextProjects.some((project) => project.id === preferred)
        ? preferred
        : (nextProjects[0]?.id ?? null);
      if (selected !== current) {
        setCards([]);
        setMachines([]);
        setQueue([]);
        setActionError(null);
        includeDoneRef.current = false;
        setFilter("open");
        setStage("all");
        setDraggedCardId(null);
        setDropColumn(null);
      }
      projectIdRef.current = selected;
      setProjects(nextProjects);
      setProjectId(selected);

      if (selected === null) {
        setCards([]);
        setMachines([]);
        setQueue([]);
      } else {
        const [result, machineResult] = await Promise.all([
          rpc.call("listCards", {
            projectId: selected,
            includeDone: includeDoneRef.current,
          }),
          rpc.call("listMachines", { projectId: selected }),
        ]);
        if (request !== requestSequence.current) return;
        setCards(result.cards);
        setQueue(result.queue);
        setMachines(machineResult.machines);
      }
      setError(null);
      setLoading(false);
    } catch (cause) {
      if (request !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("cards:changed", load);

  const previousConnection = useRef<typeof connection | null>(null);
  useEffect(() => {
    if (
      connection === "connected" &&
      previousConnection.current !== "connected"
    ) {
      void load();
    }
    previousConnection.current = connection;
  }, [connection, load]);

  const pendingThreads = useMemo(
    () =>
      new Set(
        sidebar.threads
          .filter((thread) => thread.hasPendingInteraction)
          .map((thread) => thread.id),
      ),
    [sidebar.threads],
  );
  const queuedCards = useMemo(() => {
    const result = new Map<string, { reasons: string[]; canRunNext: boolean; next: boolean }>();
    for (const machine of queue) {
      for (const waiting of machine.waiting) {
        const previous = result.get(waiting.cardId);
        result.set(waiting.cardId, {
          reasons: [...new Set([...(previous?.reasons ?? []), ...waiting.reasons])],
          canRunNext: waiting.canRunNext || previous?.canRunNext === true,
          next: machine.nextCardId === waiting.cardId || previous?.next === true,
        });
      }
    }
    return result;
  }, [queue]);
  function questionOpen(card: Card) {
    const owner = ownerThread(card);
    return owner !== null && pendingThreads.has(owner);
  }
  function queued(card: Card) {
    return card.column !== "done" && card.startRequested && card.runState === "running" && queuedCards.has(card.id);
  }
  const openCards = cards.filter((card) => card.column !== "done");
  const needsAttention = openCards.filter((card) => taskNeedsAttention(card, questionOpen(card))).length;
  const queuedCount = openCards.filter(queued).length;
  const filteredCards = cards.filter((card) => {
    if (filter === "done") return card.column === "done";
    if (card.column === "done") return false;
    if (filter === "attention") return taskNeedsAttention(card, questionOpen(card));
    if (filter === "queued") return queued(card);
    return true;
  }).filter((card) => stage === "all" || card.column === stage)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const draggedCard = view === "board" ? filteredCards.find(
    (card) => card.id === draggedCardId && card.projectId === projectId && card.runState === "running" && card.startRequested,
  ) : undefined;
  const stageColumns = COLUMNS.filter((column) => filter === "done" ? column === "done" : column !== "done");
  const visibleColumns = draggedCard ? COLUMNS : stageColumns.filter((column) => filteredCards.some((card) => card.column === column));

  function clearDrag() {
    setDraggedCardId(null);
    setDropColumn(null);
  }

  async function updateCard(card: Card, update: () => Promise<Card | { removed: boolean } | { ok: true }>) {
    if (pendingCards.has(card.id) || card.projectId !== projectIdRef.current) return;
    setPendingCards((current) => new Set(current).add(card.id));
    setError(null);
    setActionError(null);
    try {
      const result = await update();
      if (projectIdRef.current === card.projectId) {
        if ("removed" in result && result.removed) {
          setCards((current) => current.filter((item) => item.id !== card.id));
        } else if ("id" in result) {
          setCards((current) => current.map((item) => item.id === result.id && result.revision >= item.revision ? result : item));
        }
      }
      await load();
    } catch (cause) {
      if (projectIdRef.current === card.projectId) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setActionError({ cardId: card.id, message });
      }
    } finally {
      setPendingCards((current) => {
        const next = new Set(current);
        next.delete(card.id);
        return next;
      });
    }
  }

  function move(card: Card, column: Column) {
    if (!card.startRequested || card.runState !== "running" || card.column === column) return;
    void updateCard(card, () => rpc.call("moveCard", { cardId: card.id, column }));
  }

  async function add(
    title: string,
    body: string,
    files: File[],
    hostId: string,
    intake: ExecutionSelection,
    lead: ExecutionSelection,
    start: boolean,
  ) {
    const targetProjectId = projectIdRef.current;
    if (targetProjectId === null) return;
    const attachments = await Promise.all(files.map((file) => upload(targetProjectId, file)));
    await rpc.call("addCard", { projectId: targetProjectId, hostId, intake, lead, title, body, attachments, start });
    await load();
  }

  const projectName = projects.find((project) => project.id === projectId)?.name ?? "";

  function selectFilter(next: TaskFilter) {
    setFilter(next);
    setStage("all");
    clearDrag();
    if (includeDoneRef.current !== (next === "done")) {
      requestSequence.current += 1;
      includeDoneRef.current = next === "done";
      void load();
    }
  }

  function renderCard(card: Card) {
    return (
      <PipelineCard
        key={card.id}
        layout={view}
        actionError={actionError?.cardId === card.id ? actionError.message : null}
        card={card}
        machines={machines}
        onSetMachine={(hostId) => void updateCard(card, () => rpc.call("setMachine", { cardId: card.id, hostId }))}
        dragging={draggedCardId === card.id}
        pending={pendingCards.has(card.id)}
        queue={queuedCards.get(card.id) ?? null}
        onDragStart={(event) => {
          if (view !== "board" || card.runState !== "running" || !card.startRequested || pendingCards.has(card.id)) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
          setDraggedCardId(card.id);
        }}
        onDragEnd={clearDrag}
        questionOpen={questionOpen(card)}
        onOpen={(threadId) => navigate.toThread(threadId)}
        onStart={() => void updateCard(card, () => rpc.call("startCard", { cardId: card.id }))}
        onMove={(next) => void move(card, next)}
        onPause={() => void updateCard(card, () => rpc.call("pauseCard", { cardId: card.id }))}
        onResume={() => void updateCard(card, () => rpc.call("resumeCard", { cardId: card.id }))}
        onStop={() => void updateCard(card, () => rpc.call("stopCard", { cardId: card.id }))}
        onSetRunNext={(enabled) => void updateCard(card, () => rpc.call("setRunNext", { cardId: card.id, enabled }))}
        onRetry={() => {
          if (card.runState === "running") void updateCard(card, () => rpc.call("retryLaunch", { cardId: card.id }));
        }}
        onRemove={() => {
          if (card.runState === "running") void updateCard(card, () => rpc.call("removeCard", { cardId: card.id }));
        }}
      />
    );
  }

  return (
    <div className="pipeline-ui pipeline-board">
      <header className="pipeline-toolbar">
        <div className="pipeline-heading"><Icon name="Columns2" /><h1>Pipeline</h1></div>
        <label className="pipeline-project">
          <Icon name="Folder" />
          <select
            aria-label="Project"
            value={projectId ?? ""}
            disabled={projects.length === 0}
            onChange={(event) => {
              const next = event.target.value;
              requestSequence.current += 1;
              projectIdRef.current = next;
              localStorage.setItem(PROJECT_KEY, next);
              setProjectId(next);
              setCards([]);
              setError(null);
              setActionError(null);
              setMachines([]);
              setQueue([]);
              setFilter("open");
              setStage("all");
              includeDoneRef.current = false;
              clearDrag();
              void load();
            }}
          >
            {projects.length === 0 ? <option value="">{loading ? "Loading projects…" : "No projects"}</option> : null}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Icon name="ChevronDown" />
        </label>
        <div className="pipeline-toolbar-actions">
          <AddCard
            key={projectId}
            projectName={projectName}
            disabled={projectId === null || loading}
            machines={machines}
            loadExecutionDefaults={() => rpc.call("executionDefaults", null)}
            onAdd={add}
          />
        </div>
      </header>
      <div className="pipeline-viewbar">
        <div className="pipeline-views" role="group" aria-label="Layout">
          {(["list", "board"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={view === value} onClick={() => {
              setView(value);
              localStorage.setItem(VIEW_KEY, value);
              clearDrag();
            }}>{value === "list" ? "Tasks" : "Board"}</button>
          ))}
        </div>
        <div className="pipeline-machine-queues" aria-label="Machine queues">
          {queue.map((machineQueue) => <MachineQueueStatus key={machineQueue.hostId} queue={machineQueue} onOpen={(threadId) => navigate.toThread(threadId)} />)}
        </div>
        {loading ? <span role="status" className="pipeline-load-status"><Icon name="Loading" className="pipeline-spin" /><span className="sr-only">Updating…</span></span> : null}
        {connection === "reconnecting" ? <span role="status" className="pipeline-load-status">Reconnecting…</span> : null}
      </div>
      <div className="pipeline-filters">
        <div className="pipeline-filter-buttons" role="group" aria-label="Task filter">
          {([
            ["open", "Open", openCards.length],
            ["attention", "Needs you", needsAttention],
            ["queued", "Queued", queuedCount],
            ["done", "Done", null],
          ] as const).map(([value, label, count]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => selectFilter(value)}>
              {label}{count === null ? null : <span className="pipeline-filter-count">{count}</span>}
            </button>
          ))}
        </div>
        <label className="pipeline-stage-filter pipeline-select-wrap">
          <select className="pipeline-select" aria-label="Filter by stage" value={stage} onChange={(event) => {
            setStage(event.target.value as Column | "all");
            clearDrag();
          }}>
            <option value="all">All stages</option>
            {stageColumns.map((column) => <option key={column} value={column}>{COLUMN_LABELS[column]}</option>)}
          </select>
          <Icon name="ChevronDown" />
        </label>
      </div>
      {error === null ? null : <div role="alert" className="pipeline-error"><Icon name="AlertCircle" /><span>{error}</span><button type="button" className="pipeline-button pipeline-ghost" disabled={loading} onClick={() => void load()}>Refresh</button></div>}
      <div className="pipeline-scroll" onKeyDown={(event) => { if (event.key === "Escape") clearDrag(); }}>
        {filteredCards.length === 0 ? (
          loading ? <div className="pipeline-skeleton" aria-hidden="true" /> : (
            <div className="pipeline-empty-view">
              <p>{error !== null ? "Could not load tasks" : projectId === null ? "No projects" : filter === "open" && stage === "all" ? "No open tasks" : "No tasks in this view"}</p>
              {error !== null ? <button className="pipeline-button pipeline-ghost" type="button" onClick={() => void load()}>Retry</button>
                : filter === "open" && stage === "all" ? null : <button className="pipeline-button pipeline-ghost" type="button" onClick={() => selectFilter("open")}>Show open tasks</button>}
            </div>
          )
        ) : view === "list" ? (
          <div className="pipeline-task-list">
            <div className="pipeline-list-head" aria-hidden="true"><span>Task</span><span>Stage</span><span>Status</span><span>Machine</span><span /></div>
            {filteredCards.map(renderCard)}
          </div>
        ) : (
          <div className="pipeline-columns">
            {visibleColumns.map((column) => {
              const columnCards = filteredCards.filter((card) => card.column === column);
              return (
                <section key={column} aria-label={COLUMN_LABELS[column]} className="pipeline-column"
                  data-drop={Boolean(draggedCard && dropColumn === column)}
                  onDragOver={(event) => {
                    if (!draggedCard || draggedCard.column === column || pendingCards.has(draggedCard.id) || !event.dataTransfer.types.includes(CARD_DRAG_TYPE)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropColumn(column);
                  }}
                  onDragLeave={(event) => {
                    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropColumn((current) => current === column ? null : current);
                  }}
                  onDrop={(event) => {
                    if (!draggedCard || event.dataTransfer.getData(CARD_DRAG_TYPE) !== draggedCard.id) return;
                    event.preventDefault();
                    move(draggedCard, column);
                    clearDrag();
                  }}>
                  <div className="pipeline-column-header"><span className="pipeline-stage" data-stage={column} aria-hidden="true" /><h2>{COLUMN_LABELS[column]}</h2><span className="pipeline-column-count">{columnCards.length}</span></div>
                  <div className="pipeline-column-body">
                    {columnCards.map(renderCard)}
                    {draggedCard && draggedCard.column !== column && columnCards.length === 0 ? <div className="pipeline-empty">Drop here</div> : null}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
