import type {
  BbPluginApi,
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import type { CardStore } from "./store";

type Thread = MessageDispatchHookContext["thread"];

const TASK_LIMIT = 2;

interface Task {
  cardId: string;
  projectId: string;
}

export function createPipelineCapacity(bb: BbPluginApi, store: CardStore) {
  const { sdk, pluginId } = bb;

  function resolver() {
    const tasks = new Map<string, Promise<Task | null>>();

    async function resolve(thread: Thread, ancestors: Set<string>): Promise<Task | null> {
      if (ancestors.has(thread.id)) throw new Error("Cyclic Pipeline thread ancestry");
      const nextAncestors = new Set(ancestors).add(thread.id);
      const card = store.getByThread(thread.id);
      if (card !== null) return { cardId: card.id, projectId: card.projectId };
      if (thread.originPluginId === pluginId) {
        const metadata = await sdk.threads.getPluginMetadata({ threadId: thread.id, experimental_includeDeleted: true });
        if (typeof metadata.cardId === "string" && metadata.cardId.trim() !== "") {
          return { cardId: metadata.cardId, projectId: thread.projectId };
        }
      }
      if (thread.parentThreadId === null) return null;
      const parent = await sdk.threads.get({ threadId: thread.parentThreadId, experimental_includeDeleted: true });
      return resolve(parent, nextAncestors);
    }

    return (thread: Thread): Promise<Task | null> => {
      let task = tasks.get(thread.id);
      if (task === undefined) {
        task = resolve(thread, new Set());
        tasks.set(thread.id, task);
      }
      return task;
    };
  }

  return {
    async decide(context: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> {
      const taskFor = resolver();
      const task = await taskFor(context.thread);
      if (task === null || context.attempt === "join-turn") return { action: "proceed" };
      if (context.host === null) return { action: "reject", message: "Pipeline work requires a machine" };

      const running = await sdk.threads.listRunning({ experimental_includeDispatchOccupancy: true });
      const occupied = new Set<string>();
      for (const entry of running) {
        if (entry.hostId !== context.host.id) continue;
        const thread = await sdk.threads.get({ threadId: entry.id, experimental_includeDeleted: true });
        const other = await taskFor(thread);
        if (other?.projectId !== task.projectId) continue;
        if (other.cardId === task.cardId) return { action: "proceed" };
        occupied.add(other.cardId);
      }
      return occupied.size < TASK_LIMIT
        ? { action: "proceed" }
        : { action: "wait", reason: `Pipeline: ${TASK_LIMIT} tasks running on ${context.host.name}` };
    },

    async queuedCardIds(projectId: string): Promise<string[]> {
      const queue = await sdk.threads.queue.list();
      const taskFor = resolver();
      const queued = new Set<string>();
      for (const entry of queue) {
        if (entry.waitingOn?.kind !== "plugin") continue;
        const thread = await sdk.threads.get({ threadId: entry.threadId, experimental_includeDeleted: true });
        const task = await taskFor(thread);
        if (task?.projectId === projectId) queued.add(task.cardId);
      }
      return [...queued];
    },

    async publish(thread: Thread): Promise<void> {
      const task = await resolver()(thread);
      if (task === null) return;
      bb.realtime.publish("cards:changed", { projectId: task.projectId });
    },
  };
}

export type PipelineCapacity = ReturnType<typeof createPipelineCapacity>;
