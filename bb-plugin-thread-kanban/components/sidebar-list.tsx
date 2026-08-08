import { useCallback, useMemo, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginThreadListProps,
} from "@bb/plugin-sdk/app";
import { PrProbes } from "@/components/pr-probes";
import { ProjectSelect, useProjectFilter } from "@/components/project-select";
import { SidebarRow } from "@/components/sidebar-row";
import { filterBoardForDisplay } from "@/lib/display-filter";
import { effectiveExpandedIds } from "@/lib/expansion";
import { canSettle, type BoardItem } from "@/lib/lanes";
import { useBoardState } from "@/lib/use-board-state";

/**
 * The board as bb's sidebar thread list.
 *
 * The host owns the search field and the New-thread button above it, so this
 * ships neither and filters by the `searchQuery` prop. `activeProjectId` is
 * only the current route's project — using it as a filter would re-scope the
 * whole board on every navigation — so the list keeps its own scope picker.
 */
export function BoardSidebar({
  activeThreadId,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const actions = useSidebarThreadActions();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [showSettled, setShowSettled] = useState(false);
  const state = useBoardState(expandedIds, showSettled);
  const [projectId, setProjectId] = useProjectFilter(state.projects);

  const isSearching = searchQuery.trim().length > 0;

  const view = useMemo(
    () =>
      filterBoardForDisplay(state.board, { projectId, query: searchQuery }),
    [projectId, searchQuery, state.board],
  );
  const visibleExpandedIds = useMemo(
    () =>
      effectiveExpandedIds(view, {
        expandedIds,
        activeThreadId,
        revealNested: isSearching,
      }),
    [activeThreadId, expandedIds, isSearching, view],
  );

  const toggleExpanded = useCallback((threadId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  const openThread = useCallback(
    (threadId: string) => {
      // Plain open, never a split: the sidebar's whole point is that a thread
      // lands in the main area instead of re-splitting the panes.
      actions.open(threadId);
      onNavigate();
    },
    [actions, onNavigate],
  );

  const renderRow = useCallback(
    (item: BoardItem, action?: { label: string; run: () => void }) => (
      <SidebarRow
        key={item.thread.id}
        item={item}
        now={state.now}
        activeThreadId={activeThreadId}
        expandedIds={visibleExpandedIds}
        onToggleExpanded={toggleExpanded}
        onOpen={openThread}
        pullRequests={state.pullRequests}
        action={action}
      />
    ),
    [
      activeThreadId,
      visibleExpandedIds,
      openThread,
      state.now,
      state.pullRequests,
      toggleExpanded,
    ],
  );

  if (state.threadStatus === "error" || state.overridesStatus === "error") {
    return (
      <p role="status" className="px-3 py-6 text-center text-xs text-destructive">
        Could not load the board.{" "}
        {state.overridesStatus === "error" && (
          <button
            type="button"
            className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={state.retryOverrides}
          >
            Retry
          </button>
        )}
      </p>
    );
  }

  if (state.threadStatus === "loading" || state.overridesStatus === "loading") {
    return null;
  }

  const isEmpty =
    view.pinned.length + view.inbox.length + view.settled.length === 0;
  const containsActive = (item: BoardItem): boolean =>
    item.thread.id === activeThreadId || item.children.some(containsActive);
  // A search that only matches settled work must not report nothing behind a
  // collapsed header — while searching, the shelf shows its hits. The same
  // goes for the thread the user is looking at: its highlighted row must
  // exist on screen even when it lives on the settled shelf.
  const settledExpanded =
    showSettled ||
    isSearching ||
    (activeThreadId !== null && view.settled.some(containsActive));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PrProbes
        threadIds={state.probeTargetIds}
        report={state.reportPullRequest}
      />
      <div className="flex shrink-0 items-center px-2 pb-1">
        <ProjectSelect
          projects={state.projects}
          value={projectId}
          onChange={setProjectId}
          className="h-7 w-full min-w-0 rounded-md border-0 bg-transparent px-1.5 text-xs font-medium text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {isEmpty ? (
          <p role="status" className="px-2 py-6 text-center text-xs text-muted-foreground">
            {searchQuery.trim() ? "No threads found" : "No threads yet"}
          </p>
        ) : (
          <>
            {view.pinned.length > 0 && (
              <Section label="Pinned">
                {view.pinned.map((item) => renderRow(item))}
              </Section>
            )}
            <Section label="Inbox">
              {view.inbox.length === 0 ? (
                <li className="list-none px-2.5 py-1.5 text-xs text-muted-foreground">
                  All clear.
                </li>
              ) : (
                view.inbox.map((item) =>
                  renderRow(
                    item,
                    canSettle(item)
                      ? { label: "Settle", run: () => state.settle(item.thread.id) }
                      : undefined,
                  ),
                )
              )}
            </Section>
            {view.settled.length > 0 && (
              <section aria-label="Settled">
                <button
                  type="button"
                  onClick={() => setShowSettled((current) => !current)}
                  aria-expanded={settledExpanded}
                  className="mt-3 flex w-full items-center gap-2 px-2.5 pb-1 text-left"
                >
                  <span className="text-[11px] font-medium text-muted-foreground/70">
                    {settledExpanded
                      ? "Settled"
                      : `Settled (${view.settled.length})`}
                  </span>
                  <span className="h-px flex-1 bg-sidebar-border" />
                  <span aria-hidden className="text-[11px] text-muted-foreground/70">
                    {settledExpanded ? "▾" : "▸"}
                  </span>
                </button>
                {settledExpanded && (
                  <ul className="flex flex-col gap-px">
                    {view.settled.map((item) =>
                      renderRow(item, {
                        label: "Unsettle",
                        run: () => state.unsettle(item.thread.id),
                      }),
                    )}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label}>
      <h2 className="flex items-center gap-2 px-2.5 pb-1 pt-3">
        <span className="text-[11px] font-medium text-muted-foreground/70">
          {label}
        </span>
        <span className="h-px flex-1 bg-sidebar-border" />
      </h2>
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}
