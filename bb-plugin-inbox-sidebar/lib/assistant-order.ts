import { projectPinnedReorder } from "./pinned-order";

/**
 * Bot ordering. Unlike pins, bb has no notion of this order — the plugin's own
 * database stores the full list of assistant identities, and this is the
 * arithmetic that turns a stored order plus the live rows into what the
 * section shows.
 *
 * An assistant is its home, identified by `<projectId>:<home>` so the order
 * survives thread restarts and machine switches.
 */

export interface AssistantOrderRow {
  identity: string | null;
  updatedAt: number;
}

/**
 * Saved order first, then everything the order doesn't know about — new
 * assistants and rows without an identity — by newest activity. Stale ids in
 * the saved order simply match nothing; the next drag writes a clean list.
 */
export function assistantDisplayOrder<T extends AssistantOrderRow>(
  rows: readonly T[],
  savedIds: readonly string[],
): T[] {
  const rank = new Map(savedIds.map((id, index) => [id, index]));
  const rankOf = (row: T): number =>
    (row.identity !== null ? rank.get(row.identity) : undefined) ??
    Number.MAX_SAFE_INTEGER;
  return [...rows].sort(
    (a, b) => rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt,
  );
}

/**
 * One durable key per displayed assistant; rows without an identity stay
 * activity-sorted.
 */
export function orderableIdentities(
  rows: readonly Pick<AssistantOrderRow, "identity">[],
): string[] {
  return [...new Set(rows.flatMap((row) => (row.identity !== null ? [row.identity] : [])))];
}

/** A conversation drag moves its whole assistant group relative to the hovered group. */
export function projectAssistantReorder(
  rows: readonly { id: string; identity: string | null }[],
  activeId: string,
  projectedRowIds: readonly string[],
): string[] | null {
  const from = rows.findIndex((row) => row.id === activeId);
  const active = rows[from]?.identity;
  // The shared row projection inserts at the hovered row's original index.
  const to = projectedRowIds.indexOf(activeId);
  const over = rows[to]?.identity;
  if (!active || !over || active === over) return null;
  const ids = orderableIdentities(rows);
  const otherGroups = ids.filter((identity) => identity !== active);
  const destination = otherGroups.indexOf(over) + (from < to ? 1 : 0);
  return projectPinnedReorder(ids, active, ids[destination]!)?.ids ?? null;
}
