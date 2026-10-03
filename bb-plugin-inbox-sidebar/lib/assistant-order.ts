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
 * What a drag writes back: every displayed row that can be addressed — rows
 * without an identity have no durable key and stay activity-sorted.
 */
export function orderableIdentities(
  rows: readonly AssistantOrderRow[],
): string[] {
  return rows.flatMap((row) => (row.identity !== null ? [row.identity] : []));
}
