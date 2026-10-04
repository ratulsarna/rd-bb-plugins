import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type SyntheticEvent,
} from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  useSidebarSplitLayout,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { AddProjectButton } from "@/components/add-project";
import { BotsSection } from "@/components/bots-section";
import { ProjectSelect, useProjectFilter } from "@/components/project-select";
import { CollapsibleSection } from "@/components/section";
import {
  SidebarRow,
  type RowReorder,
  type SidebarRowProps,
} from "@/components/sidebar-row";
import { SortableRows } from "@/components/sortable-rows";
import { filterBoardForDisplay } from "@/lib/display-filter";
import { ancestorIdsOf, effectiveExpandedIds } from "@/lib/expansion";
import { canSettle, canSnooze, type BoardItem } from "@/lib/lanes";
import { pinnedMoveActions } from "@/lib/pinned-order";
import { useBoardState } from "@/lib/use-board-state";

/**
 * The board as bb's sidebar thread list: Bots on top, then Pinned, Inbox,
 * Snoozed and the Settled shelf, every section behind its own collapsible
 * header.
 *
 * The host owns the search field and the New-thread button above it, so this
 * ships neither and filters by the `searchQuery` prop. `activeProjectId` is
 * only the current route's project — using it as a filter would re-scope the
 * whole board on every navigation — so the list keeps its own scope picker.
 * The picker scopes the board lanes only; Bots sits outside every project
 * filter.
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
  // Every thread on screen: the route's and each split pane's.
  const splitLayout = useSidebarSplitLayout();
  const openThreadIds = useMemo(
    () =>
      [activeThreadId, ...(splitLayout?.panes ?? []).map((pane) => pane.threadId)]
        .filter((id): id is string => id !== null),
    [activeThreadId, splitLayout],
  );
  const state = useBoardState(openThreadIds);
  const [projectId, setProjectId, setPendingProjectId] = useProjectFilter(
    state.projects,
  );
  const projectNames = useMemo(
    () => new Map(state.projects.map((project) => [project.id, project.name])),
    [state.projects],
  );

  const isSearching = searchQuery.trim().length > 0;
  const menuShield = useOpenMenuShield();

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

  const openNewProject = useCallback(
    (newProjectId: string) => {
      setPendingProjectId(newProjectId);
      actions.openNewThread({ projectId: newProjectId, focusPrompt: true });
      onNavigate();
    },
    [actions, onNavigate, setPendingProjectId],
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
    (
      item: BoardItem,
      extras: Pick<SidebarRowProps, "action" | "onSnooze" | "wakeAt"> = {},
    ) => (
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
        {...extras}
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

  // Snoozed and Settled start shut, but the thread the user is looking at
  // must exist on screen — an untouched section opens itself for it. A stored
  // choice wins.
  const holdsActive = (items: readonly BoardItem[]) =>
    activeThreadId !== null &&
    items.some((item) => treeContains(item, activeThreadId));

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
    view.pinned.length +
      view.inbox.length +
      view.snoozed.length +
      view.settled.length ===
    0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" {...menuShield}>
      <div className="flex shrink-0 items-center px-2 pb-1">
        <ProjectSelect
          projects={state.projects}
          value={projectId}
          onChange={setProjectId}
          className="h-7 w-full min-w-0 rounded-md border-0 bg-transparent px-1.5 text-xs font-medium text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
        />
        <AddProjectButton onCreated={openNewProject} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        <BotsSection
          activeThreadId={activeThreadId}
          isCompactViewport={isCompactViewport}
          onNavigate={onNavigate}
          searchQuery={searchQuery}
        />
        {isEmpty ? (
          <p role="status" className="px-2 py-6 text-center text-xs text-muted-foreground">
            {searchQuery.trim() ? "No threads found" : "No threads yet"}
          </p>
        ) : (
          <>
            {view.pinned.length > 0 && (
              <CollapsibleSection
                id="pinned"
                label="Pinned"
                count={view.pinned.length}
                defaultExpanded
                forceExpanded={isSearching}
              >
                <SortableRows
                  items={view.pinned}
                  idOf={(item) => item.thread.id}
                  fullOrder={pinnedIds}
                  enabled={state.pinnedOrderReady && !isCompactViewport}
                  movePending={state.pinnedOrderMoving}
                  onMove={(threadId, projection) =>
                    movePinned(
                      threadId,
                      projection.previousThreadId,
                      projection.nextThreadId,
                    )
                  }
                >
                  {renderPinnedRow}
                </SortableRows>
              </CollapsibleSection>
            )}
            <CollapsibleSection
              id="inbox"
              label="Inbox"
              count={view.inbox.length}
              defaultExpanded
              forceExpanded={isSearching}
            >
              {view.inbox.length === 0 ? (
                <li className="list-none px-2.5 py-1.5 text-xs text-muted-foreground">
                  All clear.
                </li>
              ) : (
                view.inbox.map((item) =>
                  renderRow(item, {
                    action: canSettle(item)
                      ? { label: "Settle", run: () => state.settle(item.thread.id) }
                      : undefined,
                    onSnooze: canSnooze(item)
                      ? (until) => state.snooze(item.thread.id, until)
                      : undefined,
                  }),
                )
              )}
            </CollapsibleSection>
            {view.snoozed.length > 0 && (
              <CollapsibleSection
                id="snoozed"
                label="Snoozed"
                count={view.snoozed.length}
                defaultExpanded={holdsActive(view.snoozed)}
                forceExpanded={isSearching}
              >
                {view.snoozed.map((item) =>
                  renderRow(item, {
                    action: { label: "Wake", run: () => state.wake(item.thread.id) },
                    wakeAt: item.wakeAt,
                  }),
                )}
              </CollapsibleSection>
            )}
            {view.settled.length > 0 && (
              <CollapsibleSection
                id="settled"
                label="Settled"
                count={view.settled.length}
                defaultExpanded={holdsActive(view.settled)}
                forceExpanded={isSearching}
              >
                {view.settled.map((item) =>
                  renderRow(item, {
                    action: {
                      label: "Unsettle",
                      run: () => state.unsettle(item.thread.id),
                    },
                  }),
                )}
              </CollapsibleSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const openMenu = () =>
  document.querySelector<HTMLElement>('[role="menu"][data-state="open"]');

/**
 * While a context menu is open, a press on the list only dismisses it, as on
 * any desktop. Radix's modal menu means to do this by shutting off pointer
 * events page-wide, but the rows' labels and controls opt back in, so without
 * this a phone long-press releases into a click that opens the row, and the
 * tap that dismisses the menu activates whatever it lands on.
 *
 * It reads the open menu from the DOM instead of tracking it, so a row that
 * unmounts with its menu open cannot leave the list blocked.
 */
function useOpenMenuShield() {
  const pressBeganInMenu = useRef(false);
  // Whether the first click of the current click pair was swallowed: the
  // browser still pairs it with the next one into a dblclick (title rename).
  const firstClickSwallowed = useRef(false);
  // React delivers events from portaled menu content through this element
  // too; those are the menu's own and must be left alone.
  const fromList = (event: SyntheticEvent<HTMLDivElement>) =>
    event.currentTarget.contains(event.target as Node);
  const swallow = (event: SyntheticEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return {
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      if (!fromList(event)) return;
      const menu = openMenu();
      pressBeganInMenu.current = menu !== null;
      if (!menu) return;
      // The press is the menu's: no row drag, split, or control sees it, so
      // Radix does not either; dismiss the menu here the way Escape would.
      // Cancelable, so Radix can claim it: bb closes the mobile drawer on
      // any Escape that reaches it unclaimed.
      swallow(event);
      menu.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      const began = pressBeganInMenu.current;
      pressBeganInMenu.current = false;
      // A keyboard activation (detail 0) is never a stray tap.
      if (!fromList(event) || event.detail === 0) return;
      const stray = began || openMenu() !== null;
      if (event.detail === 1) firstClickSwallowed.current = stray;
      if (stray) swallow(event);
    },
    onDoubleClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (fromList(event) && firstClickSwallowed.current) swallow(event);
    },
  };
}

function treeContains(item: BoardItem, threadId: string): boolean {
  return (
    item.thread.id === threadId ||
    item.children.some((child) => treeContains(child, threadId))
  );
}
