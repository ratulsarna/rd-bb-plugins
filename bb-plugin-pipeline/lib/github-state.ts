import type { Card } from "./store";

export function githubAttention(card: Card): string | null {
  const status = card.github;
  if (!card.startRequested || card.column === "done" || card.runState !== "running" || status === null || status.state === "merged") return null;
  if (status.state === "closed") return "PR closed without merging";
  if (status.followup === "cancelled") return "Review follow-up cancelled; retry when ready";
  if (status.error !== null) return status.error;
  if (status.review === "unknown") return "Review outcome needs checking";
  if (status.review === "clear") return "Review settled; ready for your merge decision";
  return null;
}
