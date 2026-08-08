/**
 * Pin ordering. bb owns the order itself — `bb.sdk.threads.reorderPinned`
 * writes it and hands back the canonical list — so everything here is the
 * arithmetic around that call: how bb sorts pins, and which two neighbours a
 * move lands between.
 */

/** The fields of a bb thread-list entry that decide pin order. */
export interface PinnedThreadEntry {
  id: string;
  pinnedAt: number | null;
  pinSortKey: string | null;
  createdAt: number;
}

/**
 * bb's own pinned-root comparator (host `pinnedSidebarThreads.ts`). Threads
 * that carry a sort key order by it; anything without one — or a tie — falls
 * back to most recently pinned, then newest, then id.
 */
export function comparePinnedRoots(
  a: PinnedThreadEntry,
  b: PinnedThreadEntry,
): number {
  if (a.pinSortKey !== null && b.pinSortKey !== null) {
    if (a.pinSortKey < b.pinSortKey) return -1;
    if (a.pinSortKey > b.pinSortKey) return 1;
  }
  const pinned = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  if (pinned !== 0) return pinned;
  const created = b.createdAt - a.createdAt;
  if (created !== 0) return created;
  return a.id.localeCompare(b.id);
}

/** Where a moved thread lands: bb places it between these two. */
export interface PinnedMoveTarget {
  previousThreadId: string | null;
  nextThreadId: string | null;
}

/**
 * One step up or down the pinned list. Null at the edges and for a thread the
 * order doesn't know about — both mean "no move to make".
 */
export function pinnedMoveTarget(
  ids: readonly string[],
  threadId: string,
  direction: "up" | "down",
): PinnedMoveTarget | null {
  const index = ids.indexOf(threadId);
  if (index === -1) return null;
  if (direction === "up") {
    if (index === 0) return null;
    return {
      previousThreadId: ids[index - 2] ?? null,
      nextThreadId: ids[index - 1]!,
    };
  }
  if (index === ids.length - 1) return null;
  return {
    previousThreadId: ids[index + 1]!,
    nextThreadId: ids[index + 2] ?? null,
  };
}

/**
 * Where a drop lands. The dragged thread is removed from the list first —
 * dropping below your own old position would otherwise be off by one.
 */
export function pinnedDropTarget(
  ids: readonly string[],
  draggedId: string,
  targetId: string,
  place: "before" | "after",
): PinnedMoveTarget | null {
  if (draggedId === targetId) return null;
  if (!ids.includes(draggedId)) return null;
  const remaining = ids.filter((id) => id !== draggedId);
  const index = remaining.indexOf(targetId);
  if (index === -1) return null;
  return place === "before"
    ? { previousThreadId: remaining[index - 1] ?? null, nextThreadId: targetId }
    : { previousThreadId: targetId, nextThreadId: remaining[index + 1] ?? null };
}

export interface PinnedMove {
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveUp(): void;
  moveDown(): void;
}

/**
 * The move affordance both surfaces hand to a pinned row. Neighbours always
 * come from the full pinned order, never from a filtered view — a hidden
 * neighbour is still the thread bb will put this one beside.
 */
export function pinnedMoveActions(
  ids: readonly string[],
  threadId: string,
  move: (
    threadId: string,
    previousThreadId: string | null,
    nextThreadId: string | null,
  ) => void,
): PinnedMove {
  const up = pinnedMoveTarget(ids, threadId, "up");
  const down = pinnedMoveTarget(ids, threadId, "down");
  const run = (target: PinnedMoveTarget | null) => () => {
    if (target) move(threadId, target.previousThreadId, target.nextThreadId);
  };
  return {
    canMoveUp: up !== null,
    canMoveDown: down !== null,
    moveUp: run(up),
    moveDown: run(down),
  };
}
