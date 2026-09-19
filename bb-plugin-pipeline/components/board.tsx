import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/lib/contract";
import { COLUMNS, COLUMN_LABELS, type Column } from "@/lib/columns";
import { ownerThread, type CardAttachment } from "@/lib/store";
import { AddCard } from "./add-card";
import { PipelineCard } from "./card";

const PROJECT_KEY = "pipeline:selected-project";

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
  return {
    path: value.path,
    filename: value.name,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    isImage: value.type === "localImage",
  };
}

export function PipelineBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const navigate = useBbNavigate();
  const sidebar = useSidebarThreads();
  const connection = useRealtimeConnectionState();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [includeDone, setIncludeDone] = useState(false);
  const [cards, setCards] = useState<Awaited<ReturnType<typeof rpc.call<"listCards">>>["cards"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
      projectIdRef.current = selected;
      setProjects(nextProjects);
      setProjectId(selected);

      if (selected === null) {
        setCards([]);
      } else {
        const result = await rpc.call("listCards", {
          projectId: selected,
          includeDone: includeDoneRef.current,
        });
        if (request !== requestSequence.current) return;
        setCards(result.cards);
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
  const visibleColumns = includeDone ? COLUMNS : COLUMNS.filter((column) => column !== "done");

  async function add(title: string, body: string, files: File[]) {
    const targetProjectId = projectIdRef.current;
    if (targetProjectId === null) return;
    try {
      const attachments = await Promise.all(files.map((file) => upload(targetProjectId, file)));
      await rpc.call("addCard", { projectId: targetProjectId, title, body, attachments });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }

  const mutate = (promise: Promise<unknown>) => {
    promise.then(load, (cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-4">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <label className="text-sm">
          <span className="mr-2 text-muted-foreground">Project</span>
          <select
            aria-label="Project"
            className="rounded-md border border-input bg-background px-2 py-1.5"
            value={projectId ?? ""}
            onChange={(event) => {
              const next = event.target.value;
              requestSequence.current += 1;
              projectIdRef.current = next;
              localStorage.setItem(PROJECT_KEY, next);
              setProjectId(next);
              setCards([]);
              void load();
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeDone}
            onChange={(event) => {
              requestSequence.current += 1;
              includeDoneRef.current = event.target.checked;
              setIncludeDone(event.target.checked);
              void load();
            }}
          />
          Show done
        </label>
        <div className="ml-auto w-full max-w-md">
          <AddCard disabled={projectId === null} onAdd={add} />
        </div>
      </div>
      {error === null ? null : <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-max gap-3">
          {visibleColumns.map((column) => {
            const columnCards = cards.filter((card) => card.column === column);
            return (
              <section key={column} aria-label={COLUMN_LABELS[column]} className="flex w-72 flex-col rounded-lg bg-muted/40 p-2">
                <h2 className="mb-2 px-1 text-sm font-semibold">
                  {COLUMN_LABELS[column]} <span className="text-muted-foreground">{columnCards.length}</span>
                </h2>
                <div className="min-h-0 space-y-2 overflow-y-auto">
                  {columnCards.map((card) => {
                    const owner = ownerThread(card);
                    return (
                      <PipelineCard
                        key={card.id}
                        card={card}
                        questionOpen={owner !== null && pendingThreads.has(owner)}
                        onOpen={(threadId) => navigate.toThread(threadId)}
                        onMove={(next: Column) => mutate(rpc.call("moveCard", { cardId: card.id, column: next }))}
                        onRetry={() => mutate(rpc.call("retryLaunch", { cardId: card.id }))}
                        onRemove={() => mutate(rpc.call("removeCard", { cardId: card.id }))}
                      />
                    );
                  })}
                  {!loading && columnCards.length === 0 ? (
                    <p className="px-1 py-3 text-center text-xs text-muted-foreground">Empty</p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
