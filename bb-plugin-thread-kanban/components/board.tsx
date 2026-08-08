import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@bb/plugin-sdk/app";
import { ThreadRow } from "@/components/thread-row";
import { buildBoard, type BoardItem, type Lane } from "@/lib/lanes";

const LANE_DETAILS: Array<{
  id: Lane;
  title: string;
  description: string;
  dot: string;
  border: string;
}> = [
  {
    id: "needs-you",
    title: "Needs you",
    description: "Waiting, failed, or unread subagents",
    dot: "bg-attention",
    border: "border-attention/40",
  },
  {
    id: "running",
    title: "Running",
    description: "Agents and background work in progress",
    dot: "bg-success",
    border: "border-success/40",
  },
  {
    id: "idle",
    title: "Idle",
    description: "Recent work from the last two days",
    dot: "bg-muted-foreground/50",
    border: "border-border",
  },
];

function LaneSection({
  lane,
  items,
  projectNames,
  now,
  hiddenIdleCount,
  expandedIds,
  onToggleExpanded,
  onOpen,
}: {
  lane: (typeof LANE_DETAILS)[number];
  items: BoardItem[];
  projectNames: ReadonlyMap<string, string>;
  now: number;
  hiddenIdleCount: number;
  expandedIds: ReadonlySet<string>;
  onToggleExpanded: (threadId: string) => void;
  onOpen: (threadId: string) => void;
}) {
  return (
    <section aria-labelledby={`lane-${lane.id}`}>
      <header className="mb-2 flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={`size-2.5 rounded-full ${lane.dot}`} />
          <div className="min-w-0">
            <h2
              id={`lane-${lane.id}`}
              className="text-base font-semibold text-foreground"
            >
              {lane.title}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {lane.description}
            </p>
          </div>
        </div>
        <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </header>
      <div
        className={`overflow-hidden rounded-lg border bg-card/30 ${lane.border}`}
      >
        <div className="divide-y divide-border">
          {items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              Nothing here.
            </p>
          ) : (
            items.map((item) => (
              <ThreadRow
                key={item.thread.id}
                item={item}
                projectName={
                  projectNames.get(item.thread.projectId) ?? "Unknown project"
                }
                now={now}
                expandedIds={expandedIds}
                onToggleExpanded={onToggleExpanded}
                onOpen={onOpen}
              />
            ))
          )}
          {lane.id === "idle" && hiddenIdleCount > 0 && (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">
              {hiddenIdleCount} older{" "}
              {hiddenIdleCount === 1 ? "thread" : "threads"}
              {" — not shown"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export function ThreadBoard() {
  const { status, threads, projects } = useSidebarThreads();
  const actions = useSidebarThreadActions();
  const [projectId, setProjectId] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (projectId && !projects.some((project) => project.id === projectId)) {
      setProjectId("");
    }
  }, [projectId, projects]);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const board = useMemo(
    () => buildBoard(threads, { now, projectId: projectId || null }),
    [now, projectId, threads],
  );

  const toggleExpanded = useCallback((threadId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-sm text-muted-foreground">
        Loading threads…
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-sm text-destructive">
        Could not load threads.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <label className="min-w-0 flex-1 sm:max-w-64">
          <span className="sr-only">Filter by project</span>
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground shadow-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() =>
            actions.openNewThread({
              ...(projectId ? { projectId } : {}),
              focusPrompt: true,
            })
          }
        >
          + New thread
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {LANE_DETAILS.filter(
            (lane) =>
              lane.id !== "needs-you" || board.lanes["needs-you"].length > 0,
          ).map((lane) => (
            <LaneSection
              key={lane.id}
              lane={lane}
              items={board.lanes[lane.id]}
              projectNames={projectNames}
              now={now}
              hiddenIdleCount={board.hiddenIdleCount}
              expandedIds={expandedIds}
              onToggleExpanded={toggleExpanded}
              onOpen={(threadId) => actions.open(threadId, { split: true })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
