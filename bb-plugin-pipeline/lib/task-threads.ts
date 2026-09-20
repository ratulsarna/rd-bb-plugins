import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import type { CardStore } from "./store";

export type TaskThread = MessageDispatchHookContext["thread"];
export interface PipelineTask { cardId: string; projectId: string }

export function isThreadNotFound(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; status?: unknown };
  return error.status === 404 || error.code === "thread_not_found";
}

export function createTaskThreads(bb: BbPluginApi, store: CardStore) {
  function resolver() {
    const tasks = new Map<string, Promise<PipelineTask | null>>();
    async function resolve(thread: TaskThread, ancestors: Set<string>): Promise<PipelineTask | null> {
      if (ancestors.has(thread.id)) throw new Error("Cyclic Pipeline thread ancestry");
      const next = new Set(ancestors).add(thread.id);
      const card = store.getByThread(thread.id);
      if (card !== null) return { cardId: card.id, projectId: card.projectId };
      if (thread.originPluginId === bb.pluginId) {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id, experimental_includeDeleted: true });
        if (typeof metadata.cardId === "string" && metadata.cardId.trim() !== "") {
          return { cardId: metadata.cardId, projectId: thread.projectId };
        }
      }
      if (thread.parentThreadId === null) return null;
      return resolve(await bb.sdk.threads.get({ threadId: thread.parentThreadId, experimental_includeDeleted: true }), next);
    }
    return (thread: TaskThread): Promise<PipelineTask | null> => {
      let task = tasks.get(thread.id);
      if (task === undefined) {
        task = resolve(thread, new Set());
        tasks.set(thread.id, task);
      }
      return task;
    };
  }

  async function occupied(cardId: string): Promise<TaskThread[]> {
    const taskFor = resolver();
    const threads: TaskThread[] = [];
    for (const entry of await bb.sdk.threads.listRunning({ experimental_includeDispatchOccupancy: true })) {
      const thread = await bb.sdk.threads.get({ threadId: entry.id, experimental_includeDeleted: true });
      if ((await taskFor(thread))?.cardId === cardId) threads.push(thread);
    }
    return threads;
  }

  return { resolver, occupied };
}
