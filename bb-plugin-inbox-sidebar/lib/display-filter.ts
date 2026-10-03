import {
  threadDisplayTitle,
  type BoardItem,
  type BoardProjection,
  type BoardThread,
} from "@/lib/lanes";

export interface DisplayFilter {
  /** Empty or null means every project. */
  projectId?: string | null;
  /** The host search field's text, or "" when nothing is typed. */
  query?: string;
}

/**
 * Hide rows the user isn't looking for — and nothing else.
 *
 * The projection is built once over every thread, so lanes, rollups, settle
 * eligibility, and Pipeline PR lookups are already decided when this runs.
 * Pruning here can only remove rows from the screen.
 */
export function filterBoardForDisplay<T extends BoardThread>(
  board: BoardProjection<T>,
  filter: DisplayFilter = {},
): BoardProjection<T> {
  const projectId = filter.projectId || null;
  const needle = (filter.query ?? "").trim().toLowerCase();
  if (!projectId && !needle) return board;

  const matches = (thread: T): boolean =>
    (!projectId || thread.projectId === projectId) &&
    (!needle || threadDisplayTitle(thread).toLowerCase().includes(needle));

  // A row survives on its own match or on a descendant's: a hit buried under an
  // unrelated parent must still be reachable. Generic so each section keeps
  // its own fields (settledAt, wakeAt).
  const prune = <I extends BoardItem<T>>(item: I): I | null => {
    const children = item.children
      .map(prune)
      .filter((child): child is BoardItem<T> => child !== null);
    if (children.length === 0 && !matches(item.thread)) return null;
    return { ...item, children };
  };

  const pruneRoots = <I extends BoardItem<T>>(roots: readonly I[]): I[] =>
    roots.map(prune).filter((item): item is I => item !== null);

  return {
    pinned: pruneRoots(board.pinned),
    inbox: pruneRoots(board.inbox),
    snoozed: pruneRoots(board.snoozed),
    settled: pruneRoots(board.settled),
  };
}
