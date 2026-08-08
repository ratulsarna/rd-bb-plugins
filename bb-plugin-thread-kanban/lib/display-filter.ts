import {
  threadDisplayTitle,
  type BoardItem,
  type BoardProjection,
  type BoardThread,
  type SettledBoardItem,
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
 * eligibility and PR probe targets are already decided when this runs. Pruning
 * here can only remove rows from the screen: a tree kept alive by a child with
 * an open PR stays in the Inbox even when the search hides that child.
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
  // unrelated parent must still be reachable.
  const prune = (item: BoardItem<T>): BoardItem<T> | null => {
    const children = item.children
      .map(prune)
      .filter((child): child is BoardItem<T> => child !== null);
    if (children.length === 0 && !matches(item.thread)) return null;
    return { ...item, children };
  };

  const pruneRoots = (roots: readonly BoardItem<T>[]): BoardItem<T>[] =>
    roots.map(prune).filter((item): item is BoardItem<T> => item !== null);

  const settled = board.settled
    .map((item): SettledBoardItem<T> | null => {
      const pruned = prune(item);
      return pruned === null ? null : { ...item, children: pruned.children };
    })
    .filter((item): item is SettledBoardItem<T> => item !== null);

  return {
    pinned: pruneRoots(board.pinned),
    inbox: pruneRoots(board.inbox),
    settled,
  };
}
