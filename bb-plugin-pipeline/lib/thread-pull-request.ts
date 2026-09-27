import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { normalizePullRequestUrl } from "./github";
import type { CardStore } from "./store";
import { createTaskThreads, isThreadNotFound } from "./task-threads";

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "draft", "closed", "merged"]),
});

export const threadPullRequestsSchema = z.object({
  rows: z.array(z.object({ threadId: z.string(), pullRequest: pullRequestSchema.nullable() })),
});

export function createThreadPullRequestReader(bb: BbPluginApi, store: CardStore) {
  const taskThreads = createTaskThreads(bb, store);
  return async (threadIds: string[]): Promise<z.infer<typeof threadPullRequestsSchema>> => {
    const taskFor = taskThreads.resolver();
    const rows: z.infer<typeof threadPullRequestsSchema>["rows"] = [];
    for (const threadId of new Set(threadIds)) {
      rows.push({ threadId, pullRequest: await read(threadId) });
    }
    return { rows };

    async function read(threadId: string): Promise<z.infer<typeof pullRequestSchema> | null> {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const task = await taskFor(thread);
        const card = task === null ? null : store.get(task.cardId);
        const url = card?.prUrl ? normalizePullRequestUrl(card.prUrl) : null;
        if (card === null || url === null) return null;
        const status = card.github?.url === url ? card.github : null;
        return {
          number: Number(new URL(url).pathname.split("/")[4]),
          title: card.title,
          url,
          state: status?.state === "closed" || status?.state === "merged"
            ? status.state : status?.draft ? "draft" : "open",
        };
      } catch (cause) {
        if (isThreadNotFound(cause)) return null;
        throw cause;
      }
    }
  };
}
