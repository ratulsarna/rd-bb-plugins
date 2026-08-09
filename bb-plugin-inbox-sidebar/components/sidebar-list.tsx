import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginThreadListProps,
} from "@bb/plugin-sdk/app";
import { PrProbes } from "@/components/pr-probes";
import { PinnedReorder } from "@/components/pinned-reorder";
import { ProjectSelect, useProjectFilter } from "@/components/project-select";
import { SidebarRow, type RowReorder } from "@/components/sidebar-row";
import { filterBoardForDisplay } from "@/lib/display-filter";
import { ancestorIdsOf, effectiveExpandedIds } from "@/lib/expansion";
import {
  canSettle,
  selectPrProbeTargets,
  type BoardItem,
} from "@/lib/lanes";
import { pinnedMoveActions } from "@/lib/pinned-order";
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
  isCompactViewport,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const actions = useSidebarThreadActions();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  // null means "no explicit choice yet", so the shelf can open itself for a
  // search hit or the active thread — and one click still overrules that.
  const [showSettled, setShowSettled] = useState<boolean | null>(null);
  const state = useBoardState();
  const [projectId, setProjectId] = useProjectFilter(state.projects);
  const projectNames = useMemo(
    () => new Map(state.projects.map((project) => [project.id, project.name])),
    [state.projects],
  );

  const isSearching = searchQuery.trim().length > 0;

  const view = useMemo(
    () =>
      filterBoardForDisplay(state.board, { projectId, query: searchQuery }),
    [projectId, searchQuery, state.board],
  );
  const visibleExpandedIds = useMemo(
    () => effectiveExpandedIds(view, { expandedIds, revealNested: isSearching }),
    [expandedIds, isSearching, view],
  );

  // Open the active thread's ancestors once, into the user's own set, rather
  // than deriving it every render — derived, it would re-open the row the
  // instant the user collapsed it. Keyed on the thread we last opened for, so
  // a board that arrives after the route still gets its one chance.
  const openedForActive = useRef<string | null>(null);
  useEffect(() => {
    if (!activeThreadId) {
      openedForActive.current = null;
      return;
    }
    if (openedForActive.current === activeThreadId) return;
    const ancestors = ancestorIdsOf(state.board, activeThreadId);
    if (ancestors === null) return;
    openedForActive.current = activeThreadId;
    if (ancestors.length === 0) return;
    setExpandedIds((current) => {
      if (ancestors.every((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of ancestors) next.add(id);
      return next;
    });
  }, [activeThreadId, state.board]);

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
      // Clicks open plainly. The host split hook owns only the drag gesture.
      actions.open(threadId);
      onNavigate();
    },
    [actions, onNavigate],
  );

  const renameThread = useCallback(
    (threadId: string, title: string) => actions.rename(threadId, title),
    [actions],
  );
  const startRename = useCallback((threadId: string) => {
    setRenamingThreadId(threadId);
  }, []);
  const cancelRename = useCallback(() => setRenamingThreadId(null), []);

  const renderRow = useCallback(
    (item: BoardItem, action?: { label: string; run: () => void }) => (
      <SidebarRow
        key={item.thread.id}
        item={item}
        projectNames={projectNames}
        now={state.now}
        activeThreadId={activeThreadId}
        renamingThreadId={renamingThreadId}
        expandedIds={visibleExpandedIds}
        onToggleExpanded={toggleExpanded}
        onOpen={openThread}
        onStartRename={startRename}
        onCancelRename={cancelRename}
        onRename={renameThread}
        pullRequests={state.pullRequests}
        action={action}
      />
    ),
    [
      activeThreadId,
      cancelRename,
      renamingThreadId,
      visibleExpandedIds,
      openThread,
      projectNames,
      renameThread,
      startRename,
      state.now,
      state.pullRequests,
      toggleExpanded,
    ],
  );

  // Neighbours always come from the full pinned list, never from `view`: a
  // thread the search or the project filter hid is still the one bb will
  // place this row beside.
  const pinnedIds = useMemo(
    () => state.board.pinned.map((item) => item.thread.id),
    [state.board.pinned],
  );

  const movePinned = state.movePinned;
  const renderPinnedRow = useCallback(
    (item: BoardItem, reorder?: RowReorder) => {
      const threadId = item.thread.id;
      // Both affordances wait on bb's order, not just the pointer gesture:
      // moving against a stale rank would place it beside the wrong neighbour.
      const pinnedMove =
        state.pinnedOrderReady && !state.pinnedOrderMoving
          ? pinnedMoveActions(pinnedIds, threadId, movePinned)
          : undefined;
      return (
        <SidebarRow
          key={threadId}
          item={item}
          projectNames={projectNames}
          now={state.now}
          activeThreadId={activeThreadId}
          renamingThreadId={renamingThreadId}
          expandedIds={visibleExpandedIds}
          onToggleExpanded={toggleExpanded}
          onOpen={openThread}
          onStartRename={startRename}
          onCancelRename={cancelRename}
          onRename={renameThread}
          pullRequests={state.pullRequests}
          pinnedMove={pinnedMove}
          reorder={reorder}
        />
      );
    },
    [
      activeThreadId,
      cancelRename,
      movePinned,
      openThread,
      pinnedIds,
      projectNames,
      renamingThreadId,
      renameThread,
      startRename,
      state.now,
      state.pinnedOrderMoving,
      state.pinnedOrderReady,
      state.pullRequests,
      toggleExpanded,
      visibleExpandedIds,
    ],
  );

  // A search that only matches settled work must not report nothing behind a
  // collapsed header, and the thread the user is looking at must exist on
  // screen even when it lives on the settled shelf. Both are defaults: one
  // click on the header overrules them for as long as the list is mounted.
  const settledExpanded =
    showSettled ??
    (isSearching ||
      (activeThreadId !== null &&
        view.settled.some((item) => treeContains(item, activeThreadId))));

  // Probes read the same expanded set the rows do. Selecting off the raw
  // toggle state would leave a revealed row unprobed and badge-less.
  const probeTargetIds = useMemo(
    () => [...selectPrProbeTargets(state.board, visibleExpandedIds)],
    [state.board, visibleExpandedIds],
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PrProbes
        threadIds={probeTargetIds}
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
                <PinnedReorder
                  items={view.pinned}
                  fullOrder={pinnedIds}
                  enabled={state.pinnedOrderReady && !isCompactViewport}
                  movePending={state.pinnedOrderMoving}
                  onMove={movePinned}
                >
                  {renderPinnedRow}
                </PinnedReorder>
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
                  onClick={() => setShowSettled(!settledExpanded)}
                  aria-expanded={settledExpanded}
                  className="mt-5 flex w-full items-center gap-2 px-2.5 pb-2 text-left"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
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
                  <ul className="flex flex-col gap-1">
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

function treeContains(item: BoardItem, threadId: string): boolean {
  return (
    item.thread.id === threadId ||
    item.children.some((child) => treeContains(child, threadId))
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
      <h2 className="flex items-center gap-2 px-2.5 pb-2 pt-5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          {label}
        </span>
        <span className="h-px flex-1 bg-sidebar-border" />
      </h2>
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  );
}
