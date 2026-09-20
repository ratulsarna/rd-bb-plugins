import type {
  BbPluginApi,
  MessageDispatchHookContext,
  PluginBbSdk,
} from "@get-bb/plugin-sdk";
import type { CardStore } from "./store";
import type { PipelineRole } from "./spawn";

export type TaskThread = MessageDispatchHookContext["thread"];
export interface PipelineTask { cardId: string; projectId: string; hostId: string | null }

export function isThreadNotFound(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; status?: unknown };
  return error.status === 404 || error.code === "thread_not_found";
}

const THREAD_PAGE_SIZE = 100;

export async function findPipelineThreadByMetadata(
  sdk: PluginBbSdk,
  input: { projectId: string; cardId: string; role: PipelineRole },
): Promise<Awaited<ReturnType<PluginBbSdk["threads"]["get"]>> | null> {
  for (const archived of [false, true]) {
    for (let offset = 0; ; offset += THREAD_PAGE_SIZE) {
      const threads = await sdk.threads.list({
        projectId: input.projectId,
        originPluginId: "pipeline",
        includeHidden: true,
        archived,
        limit: THREAD_PAGE_SIZE,
        offset,
      });
      for (const thread of threads) {
        const metadata = await sdk.threads.getPluginMetadata({
          threadId: thread.id,
        });
        if (metadata.cardId === input.cardId && metadata.role === input.role) {
          return sdk.threads.get({ threadId: thread.id });
        }
      }
      if (threads.length < THREAD_PAGE_SIZE) break;
    }
  }
  return null;
}

export function createTaskThreads(bb: BbPluginApi, store: CardStore) {
  function resolver() {
    const tasks = new Map<string, Promise<PipelineTask | null>>();
    async function resolve(thread: TaskThread, ancestors: Set<string>): Promise<PipelineTask | null> {
      if (ancestors.has(thread.id)) throw new Error("Cyclic Pipeline thread ancestry");
      const next = new Set(ancestors).add(thread.id);
      const card = store.getByThread(thread.id);
      if (card !== null) return { cardId: card.id, projectId: card.projectId, hostId: card.hostId };
      if (thread.originPluginId === bb.pluginId) {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id, experimental_includeDeleted: true });
        if (typeof metadata.cardId === "string" && metadata.cardId.trim() !== "") {
          return { cardId: metadata.cardId, projectId: thread.projectId,
            hostId: store.get(metadata.cardId)?.hostId ?? (typeof metadata.hostId === "string" ? metadata.hostId : null),
          };
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

  async function occupancy(hostId?: string) {
    const taskFor = resolver();
    const entries: Array<{ thread: TaskThread; task: PipelineTask; hostId: string | null }> = [];
    for (const entry of await bb.sdk.threads.listRunning({ experimental_includeDispatchOccupancy: true })) {
      if (hostId !== undefined && entry.hostId !== hostId) continue;
      const thread = await bb.sdk.threads.get({ threadId: entry.id, experimental_includeDeleted: true });
      const task = await taskFor(thread);
      if (task !== null) entries.push({ thread, task, hostId: entry.hostId });
    }
    return entries;
  }

  async function occupied(cardId: string): Promise<TaskThread[]> {
    return (await occupancy()).filter((entry) => entry.task.cardId === cardId).map((entry) => entry.thread);
  }

  return { resolver, occupancy, occupied };
}
