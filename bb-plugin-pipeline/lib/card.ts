import type { Card, CardOwnerRole } from "./store";

export const PAUSE_DELIVERY_PENDING = "Pause instruction pending delivery";

export function requireStarted(card: Card, action: string): void {
  if (card.startRequested) return;
  throw new Error(`card ${card.id} is saved; start it before ${action}`);
}

export function roleThread(card: Card, role: CardOwnerRole): string | null {
  return role === "lead" ? card.leadThreadId : card.intakeThreadId;
}

export function ownerThread(card: Card): string | null {
  return roleThread(card, card.ownerRole);
}
