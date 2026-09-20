import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ownerThread } from "./card";
import type { Card } from "./store";

export function userAttentionReason(card: Card): string | null {
  if (card.needsUser) return card.attentionReason?.trim() || "Needs your input";
  if (card.launchError !== null) return `Launch failed: ${card.launchError}`;
  if (card.threadError !== null) return `Thread failed: ${card.threadError}`;
  return null;
}

export function createAttentionNotifier(bb: BbPluginApi) {
  const pending = new Set<Promise<void>>();
  const outputSchema = z.object({ delivery: z.enum(["skipped", "queued", "held"]) });
  bb.onDispose(async () => { await Promise.allSettled([...pending]); });

  return (card: Card, reason: string): void => {
    if (card.column === "done" || card.runState !== "running") return;
    const delivery = bb.sdk.plugins.callRpc({
      pluginId: "notify",
      method: "send",
      input: {
        title: `Pipeline: ${card.title}`.slice(0, 256),
        message: reason.slice(0, 4000),
        projectId: card.projectId,
        threadId: ownerThread(card),
      },
      outputSchema,
      signal: AbortSignal.timeout(5_000),
    }).then(() => undefined).catch((cause: unknown) => {
      bb.log.warn(`could not notify attention for card ${card.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    pending.add(delivery);
    void delivery.finally(() => pending.delete(delivery));
  };
}
