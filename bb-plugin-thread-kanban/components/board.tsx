import { useCallback, useMemo, useState } from "react";
import { experimental_useSidebarThreadActions as useSidebarThreadActions } from "@bb/plugin-sdk/app";
import { PrProbes } from "@/components/pr-probes";
import { ProjectSelect, useProjectFilter } from "@/components/project-select";
import { ThreadRow } from "@/components/thread-row";
import { filterBoardForDisplay } from "@/lib/display-filter";
import { canSettle, type BoardItem } from "@/lib/lanes";
import { pinnedMoveActions } from "@/lib/pinned-order";
import { useBoardState } from "@/lib/use-board-state";

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
  const actions = useSidebarThreadActions();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [showSettled, setShowSettled] = useState(false);
  const state = useBoardState(expandedIds, showSettled);
  const [projectId, setProjectId] = useProjectFilter(state.projects);

  // The panel's select is a display filter like the sidebar's search: it hides
  // rows, it never changes what settled or what gets probed.
  const view = useMemo(
    () => filterBoardForDisplay(state.board, { projectId }),
    [projectId, state.board],
  );

  const projectNames = useMemo(
    () =>
      new Map(
        state.projects.map((project) => [project.id, project.name] as const),
      ),
    [state.projects],
  );

  const toggleExpanded = useCallback((threadId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  // Neighbours come from the full pinned list, never from the project-filtered
  // view: a hidden neighbour is still the thread bb will place this one beside.
  const pinnedIds = useMemo(
    () => state.board.pinned.map((item) => item.thread.id),
    [state.board.pinned],
  );

  const renderRow = useCallback(
    (
      item: BoardItem,
      action?: { label: string; run: () => void },
      isPinnedRoot = false,
    ) => (
      <ThreadRow
        key={item.thread.id}
        item={item}
        pinnedMove={
          // The panel has no drag handle, so this menu is the only way to
          // reorder here — and it waits for bb's order like the sidebar does.
          isPinnedRoot && state.pinnedOrderReady
            ? pinnedMoveActions(pinnedIds, item.thread.id, state.movePinned)
            : undefined
        }
        projectName={
          projectNames.get(item.thread.projectId) ?? "Unknown project"
        }
        now={state.now}
        expandedIds={expandedIds}
        onToggleExpanded={toggleExpanded}
        onOpen={(threadId) => actions.open(threadId, { split: true })}
        pullRequest={state.pullRequests.get(item.thread.id) ?? null}
        pullRequests={state.pullRequests}
        action={action}
      />
    ),
    [
      actions,
      expandedIds,
      pinnedIds,
      projectNames,
      state.movePinned,
      state.now,
      state.pinnedOrderReady,
      state.pullRequests,
      toggleExpanded,
    ],
  );

  if (state.threadStatus === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-sm text-destructive">
        Could not load threads.
      </div>
    );
  }

  if (state.overridesStatus === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-sm text-destructive">
        <p>Could not load settled threads.</p>
        <button
          type="button"
          className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 font-medium text-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={state.retryOverrides}
        >
          Retry
        </button>
      </div>
    );
  }

  if (
    state.threadStatus === "loading" ||
    state.overridesStatus === "loading"
  ) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-sm text-muted-foreground">
        Loading threads…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PrProbes
        threadIds={state.probeTargetIds}
        report={state.reportPullRequest}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <label className="min-w-0 flex-1 sm:max-w-64">
          <span className="sr-only">Filter by project</span>
          <ProjectSelect
            projects={state.projects}
            value={projectId}
            onChange={setProjectId}
            className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground shadow-sm outline-none focus:ring-2 focus:ring-ring"
          />
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
          {view.pinned.length > 0 && (
            <Section id="priority" title="Pinned" count={view.pinned.length}>
              {view.pinned.map((item) => renderRow(item, undefined, true))}
            </Section>
          )}
          <Section id="inbox" title="Inbox" count={view.inbox.length}>
            {view.inbox.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                All clear.
              </p>
            ) : (
              view.inbox.map((item) =>
                renderRow(
                  item,
                  canSettle(item)
                    ? {
                        label: "Settle",
                        run: () => state.settle(item.thread.id),
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
                  {view.settled.length}
                </span>
              </button>
            </header>
            {showSettled && (
              <div className="overflow-hidden rounded-lg border border-border bg-card/30">
                <div className="divide-y divide-border">
                  {view.settled.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      Nothing settled yet.
                    </p>
                  ) : (
                    view.settled.map((item) =>
                      renderRow(item, {
                        label: "Unsettle",
                        run: () => state.unsettle(item.thread.id),
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
