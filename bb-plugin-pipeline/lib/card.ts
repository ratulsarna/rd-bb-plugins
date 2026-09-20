import type { Card, CardOwnerRole } from "./store";

export function roleThread(card: Card, role: CardOwnerRole): string | null {
  return role === "lead" ? card.leadThreadId : card.intakeThreadId;
}

export function ownerThread(card: Card): string | null {
  return roleThread(card, card.ownerRole);
}
