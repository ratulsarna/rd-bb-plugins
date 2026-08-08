import type { BoardItem, BoardProjection, BoardThread } from "@/lib/lanes";

export interface ExpansionOptions {
  /** Rows the user opened by hand. Never written to. */
  expandedIds: ReadonlySet<string>;
  /**
   * Open every row that still has children. Set while a search is running:
   * the filter has already dropped everything that isn't a match or the path
   * to one, so opening the rest reveals exactly the hits.
   */
  revealNested?: boolean;
}

/**
 * The ancestors of one thread, outermost first, or null when the board does
 * not hold that thread at all — the caller needs to tell "it is a root" apart
 * from "it has not loaded yet".
 */
export function ancestorIdsOf<T extends BoardThread>(
  board: BoardProjection<T>,
  threadId: string,
): string[] | null {
  const path: string[] = [];
  let found: string[] | null = null;

  const visit = (item: BoardItem<T>) => {
    if (found) return;
    if (item.thread.id === threadId) {
      found = [...path];
      return;
    }
    path.push(item.thread.id);
    for (const child of item.children) visit(child);
    path.pop();
  };

  for (const root of board.pinned) visit(root);
  for (const root of board.inbox) visit(root);
  for (const root of board.settled) visit(root);

  return found;
}

/**
 * Which rows render expanded, derived per render from the filtered view.
 *
 * Only search reveal is derived. Opening the active thread's ancestors is a
 * one-off write into the user's own set instead (see the sidebar): deriving it
 * every render would silently undo a collapse the moment it happened.
 */
export function effectiveExpandedIds<T extends BoardThread>(
  board: BoardProjection<T>,
  options: ExpansionOptions,
): ReadonlySet<string> {
  const { expandedIds, revealNested = false } = options;
  const revealed = new Set<string>();
  if (!revealNested) return expandedIds;

  const visit = (item: BoardItem<T>) => {
    if (item.children.length > 0) revealed.add(item.thread.id);
    for (const child of item.children) visit(child);
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
