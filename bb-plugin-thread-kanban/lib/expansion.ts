import type { BoardItem, BoardProjection, BoardThread } from "@/lib/lanes";

export interface ExpansionOptions {
  /** Rows the user opened by hand. Never written to. */
  expandedIds: ReadonlySet<string>;
  /** The route's thread. Its ancestors open so the row it highlights exists. */
  activeThreadId?: string | null;
  /**
   * Open every row that still has children. Set while a search is running:
   * the filter has already dropped everything that isn't a match or the path
   * to one, so opening the rest reveals exactly the hits.
   */
  revealNested?: boolean;
}

/**
 * Which rows render expanded, derived per render from the filtered view.
 *
 * A collapsed parent otherwise swallows its children whole: reload onto a
 * subagent thread and the row bb asked us to highlight is not on screen, and
 * a search that only matches a child finds nothing to show. The user's own
 * toggles stay untouched — this only ever adds to them.
 */
export function effectiveExpandedIds<T extends BoardThread>(
  board: BoardProjection<T>,
  options: ExpansionOptions,
): ReadonlySet<string> {
  const { expandedIds, activeThreadId = null, revealNested = false } = options;
  const revealed = new Set<string>();
  const path: string[] = [];

  const visit = (item: BoardItem<T>) => {
    if (revealNested && item.children.length > 0) revealed.add(item.thread.id);
    if (item.thread.id === activeThreadId) {
      for (const ancestorId of path) revealed.add(ancestorId);
    }
    path.push(item.thread.id);
    for (const child of item.children) visit(child);
    path.pop();
  };

  for (const root of board.pinned) visit(root);
  for (const root of board.inbox) visit(root);
  for (const root of board.settled) visit(root);

  // Identity matters: an unchanged set keeps the row callbacks memoized.
  let added = false;
  for (const threadId of revealed) {
    if (!expandedIds.has(threadId)) {
      added = true;
      break;
    }
  }
  if (!added) return expandedIds;

  const result = new Set(expandedIds);
  for (const threadId of revealed) result.add(threadId);
  return result;
}
