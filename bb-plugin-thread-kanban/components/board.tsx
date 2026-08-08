import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarPullRequest,
} from "@bb/plugin-sdk/app";
import { ThreadRow } from "@/components/thread-row";
import { useSettledOverrides } from "@/lib/use-settled";
import {
  buildBoard,
  canSettle,
  selectPrProbeTargets,
  type BoardItem,
  type PrState,
} from "@/lib/lanes";

function PrProbe({
  threadId,
  report,
}: {
  threadId: string;
  report: (threadId: string, pullRequest: PluginSidebarPullRequest | null) => void;
}) {
  const { isLoading, pullRequest } = useSidebarThreadPullRequest(threadId);

  useEffect(() => {
    if (!isLoading) report(threadId, pullRequest);
  }, [isLoading, pullRequest, report, threadId]);

  return null;
}

function samePullRequest(
  left: PluginSidebarPullRequest | null | undefined,
  right: PluginSidebarPullRequest | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.number === right.number &&
    left.title === right.title &&
    left.url === right.url &&
    left.state === right.state &&
    left.attention === right.attention
  );
}

function Section({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`section-${id}`}>
      <header className="mb-2 flex items-center gap-2 px-1">
        <h2
          id={`section-${id}`}
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {title}
        </h2>
        <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      </header>
      <div className="overflow-hidden rounded-lg border border-border bg-card/30">
        <div className="divide-y divide-border">{children}</div>
      </div>
    </section>
  );
}

export function ThreadBoard() {
  const { status: threadStatus, threads, projects } = useSidebarThreads();
  const actions = useSidebarThreadActions();
  const settledApi = useSettledOverrides();
  const [projectId, setProjectId] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [showSettled, setShowSettled] = useState(false);
  const [pullRequests, setPullRequests] = useState<
    Map<string, PluginSidebarPullRequest | null>
  >(
    () => new Map(),
  );
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

  const reportPullRequest = useCallback(
    (threadId: string, pullRequest: PluginSidebarPullRequest | null) => {
      setPullRequests((current) => {
        const existing = current.get(threadId);
        if (
          pullRequest === null &&
          (existing?.state === "open" || existing?.state === "draft")
        ) {
          return current;
        }
        if (current.has(threadId) && samePullRequest(existing, pullRequest)) {
          return current;
        }
        const next = new Map(current);
        next.set(threadId, pullRequest);
        return next;
      });
    },
    [],
  );

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const visibleThreadIds = useMemo(
    () =>
      new Set(
        threads
          .filter(
            (thread) =>
              !thread.isArchived &&
              (!projectId || thread.projectId === projectId),
          )
          .map((thread) => thread.id),
      ),
    [projectId, threads],
  );

  useEffect(() => {
    setPullRequests((current) => {
      let changed = false;
      const next = new Map(current);
      for (const threadId of next.keys()) {
        if (!visibleThreadIds.has(threadId)) {
          next.delete(threadId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [visibleThreadIds]);

  const prStates = useMemo(
    () =>
      new Map<string, PrState | null>(
        [...pullRequests].map(([threadId, pullRequest]) => [
          threadId,
          pullRequest?.state ?? null,
        ]),
      ),
    [pullRequests],
  );
  const board = useMemo(
    () =>
      buildBoard(threads, {
        now,
        projectId: projectId || null,
        overrides: settledApi.overrides,
        prStates,
      }),
    [now, prStates, projectId, settledApi.overrides, threads],
  );
  const probeTargetIds = useMemo(
    () => [...selectPrProbeTargets(board, expandedIds, showSettled)],
    [board, expandedIds, showSettled],
  );

  const toggleExpanded = useCallback((threadId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  const renderRow = useCallback(
    (item: BoardItem, action?: { label: string; run: () => void }) => (
      <ThreadRow
        key={item.thread.id}
        item={item}
        projectName={
          projectNames.get(item.thread.projectId) ?? "Unknown project"
        }
        now={now}
        expandedIds={expandedIds}
        onToggleExpanded={toggleExpanded}
        onOpen={(threadId) => actions.open(threadId, { split: true })}
        pullRequest={pullRequests.get(item.thread.id) ?? null}
        pullRequests={pullRequests}
        action={action}
      />
    ),
    [actions, expandedIds, now, projectNames, pullRequests, toggleExpanded],
  );

  if (threadStatus === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-sm text-destructive">
        Could not load threads.
      </div>
    );
  }

  if (settledApi.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-sm text-destructive">
        <p>Could not load settled threads.</p>
        <button
          type="button"
          className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 font-medium text-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void settledApi.refresh()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (threadStatus === "loading" || settledApi.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-sm text-muted-foreground">
        Loading threads…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {probeTargetIds.map((threadId) => (
        <PrProbe
          key={threadId}
          threadId={threadId}
          report={reportPullRequest}
        />
      ))}
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
          {board.pinned.length > 0 && (
            <Section id="priority" title="Priority" count={board.pinned.length}>
              {board.pinned.map((item) => renderRow(item))}
            </Section>
          )}
          <Section id="inbox" title="Inbox" count={board.inbox.length}>
            {board.inbox.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                All clear.
              </p>
            ) : (
              board.inbox.map((item) =>
                renderRow(
                  item,
                  canSettle(item)
                    ? {
                        label: "Settle",
                        run: () => settledApi.settle(item.thread.id),
                      }
                    : undefined,
                ),
              )
            )}
          </Section>
          <section aria-labelledby="section-settled">
            <header className="mb-2 px-1">
              <button
                type="button"
                className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setShowSettled((current) => !current)}
                aria-expanded={showSettled}
              >
                <span aria-hidden>{showSettled ? "▾" : "▸"}</span>
                <h2 id="section-settled">Settled</h2>
                <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs font-medium tabular-nums">
                  {board.settled.length}
                </span>
              </button>
            </header>
            {showSettled && (
              <div className="overflow-hidden rounded-lg border border-border bg-card/30">
                <div className="divide-y divide-border">
                  {board.settled.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      Nothing settled yet.
                    </p>
                  ) : (
                    board.settled.map((item) =>
                      renderRow(item, {
                        label: "Unsettle",
                        run: () => settledApi.unsettle(item.thread.id),
                      }),
                    )
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
