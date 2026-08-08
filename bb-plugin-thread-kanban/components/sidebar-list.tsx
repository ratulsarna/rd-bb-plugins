import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginThreadListProps,
} from "@bb/plugin-sdk/app";
import { PrProbes } from "@/components/pr-probes";
import { ProjectSelect, useProjectFilter } from "@/components/project-select";
import { SidebarRow } from "@/components/sidebar-row";
import { filterBoardForDisplay } from "@/lib/display-filter";
import { ancestorIdsOf, effectiveExpandedIds } from "@/lib/expansion";
import {
  canSettle,
  selectPrProbeTargets,
  type BoardItem,
} from "@/lib/lanes";
import { pinnedDropTarget, pinnedMoveActions } from "@/lib/pinned-order";
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
  // null means "no explicit choice yet", so the shelf can open itself for a
  // search hit or the active thread — and one click still overrules that.
  const [showSettled, setShowSettled] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<{
    threadId: string;
    place: "before" | "after";
  } | null>(null);
  const state = useBoardState();
  const [projectId, setProjectId] = useProjectFilter(state.projects);

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

  // Neighbours always come from the full pinned list, never from `view`: a
  // thread the search or the project filter hid is still the one bb will
  // place this row beside.
  const pinnedIds = useMemo(
    () => state.board.pinned.map((item) => item.thread.id),
    [state.board.pinned],
  );

  const movePinned = state.movePinned;
  const dropSomewhere = useCallback(
    (targetId: string, place: "before" | "after") => {
      if (!dragging) return;
      const target = pinnedDropTarget(pinnedIds, dragging, targetId, place);
      if (target) {
        movePinned(dragging, target.previousThreadId, target.nextThreadId);
      }
      setDragging(null);
      setDropOn(null);
    },
    [dragging, movePinned, pinnedIds],
  );

  const renderPinnedRow = useCallback(
    (item: BoardItem) => {
      const threadId = item.thread.id;
      // Both affordances wait on bb's order, not just the drag handle: moving
      // against a stale rank would place the thread beside the wrong neighbour.
      const pinnedMove = state.pinnedOrderReady
        ? pinnedMoveActions(pinnedIds, threadId, movePinned)
        : undefined;
      return (
        <SidebarRow
          key={threadId}
          item={item}
          now={state.now}
          activeThreadId={activeThreadId}
          expandedIds={visibleExpandedIds}
          onToggleExpanded={toggleExpanded}
          onOpen={openThread}
          pullRequests={state.pullRequests}
          pinnedMove={pinnedMove}
          drag={
            // No handle until bb's order is known, and none on a phone: there
            // is no drag there, which is why the context menu carries moves.
            state.pinnedOrderReady && !isCompactViewport
              ? {
                  indicator:
                    dropOn?.threadId === threadId ? dropOn.place : null,
                  onDragStart: (event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", threadId);
                    setDragging(threadId);
                  },
                  onDragEnd: () => {
                    setDragging(null);
                    setDropOn(null);
                  },
                  onDragOver: (event) => {
                    if (!dragging || dragging === threadId) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const box = event.currentTarget.getBoundingClientRect();
                    const place =
                      event.clientY < box.top + box.height / 2
                        ? "before"
                        : "after";
                    setDropOn((current) =>
                      current?.threadId === threadId && current.place === place
                        ? current
                        : { threadId, place },
                    );
                  },
                  onDragLeave: () => {
                    setDropOn((current) =>
                      current?.threadId === threadId ? null : current,
                    );
                  },
                  onDrop: (event) => {
                    event.preventDefault();
                    dropSomewhere(threadId, dropOn?.place ?? "before");
                  },
                }
              : undefined
          }
        />
      );
    },
    [
      activeThreadId,
      dragging,
      dropOn,
      dropSomewhere,
      isCompactViewport,
      movePinned,
      openThread,
      pinnedIds,
      state.now,
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

  // Probes read exactly what the rows render from. Selecting off the raw
  // toggle state would leave a revealed row unprobed and badge-less.
  const probeTargetIds = useMemo(
    () => [...selectPrProbeTargets(state.board, visibleExpandedIds, settledExpanded)],
    [settledExpanded, state.board, visibleExpandedIds],
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
                {view.pinned.map((item) => renderPinnedRow(item))}
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
