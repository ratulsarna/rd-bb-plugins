/** Realtime channel every open panel re-reads the order on. */
export const CARD_ORDER_CHANNEL = "card-order";

/** Saved card orders longer than this are not a list of usage cards. */
export const MAX_CARD_ORDER = 100;

export interface OrderableCard {
  id: "codex" | "zai" | "claudeCode";
  accountId?: string;
}

export function cardKey(card: OrderableCard): string {
  return card.id === "claudeCode" ? `claudeCode:${card.accountId}` : card.id;
}

/**
 * Cards in the saved order. A card the saved order doesn't name (a new
 * account) keeps its place among the unnamed ones, after the named ones;
 * saved keys with no card (a removed account) are skipped.
 */
export function orderCards<T extends OrderableCard>(
  cards: readonly T[],
  saved: readonly string[],
): T[] {
  const rank = new Map(saved.map((key, index) => [key, index]));
  return cards
    .map((card, index) => ({ card, index, rank: rank.get(cardKey(card)) }))
    .sort(
      (a, b) =>
        (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .map(({ card }) => card);
}

/** The shown order with `active` moved to where `over` is. */
export function moveCard(
  shown: readonly string[],
  active: string,
  over: string,
): string[] {
  const from = shown.indexOf(active);
  const to = shown.indexOf(over);
  if (from < 0 || to < 0 || from === to) return [...shown];
  const next = [...shown];
  next.splice(from, 1);
  next.splice(to, 0, active);
  return next;
}
