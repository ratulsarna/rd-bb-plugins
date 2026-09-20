import type {
  BbPluginApi,
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import type { CardStore } from "./store";
import { createTaskThreads } from "./task-threads";
import { ownerThread } from "./card";
import { pauseInstruction } from "./control-prompts";

type Thread = MessageDispatchHookContext["thread"];

const TASK_LIMIT = 2;

export function createPipelineCapacity(bb: BbPluginApi, store: CardStore) {
  const { sdk } = bb;
  const { resolver } = createTaskThreads(bb, store);

  return {
    async decide(context: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> {
      const taskFor = resolver();
      const task = await taskFor(context.thread);
      if (task === null) return { action: "proceed" };
      const card = store.get(task.cardId);
      if (card !== null && card.runState !== "running") {
        const pauseControl = card.runState === "pause_requested" &&
          context.thread.id === ownerThread(card) &&
          context.input.text === pauseInstruction(card);
        // Core's worker completion notices have no sender thread.
        const coordinating = card.runState === "pause_requested" &&
          context.thread.status !== "pending" && (context.initiator === "system" ||
            (context.senderThreadId !== null && context.senderThreadId !== "mixed" &&
              (await taskFor(await sdk.threads.get({ threadId: context.senderThreadId, experimental_includeDeleted: true })))?.cardId === card.id));
        if (!pauseControl && !coordinating) return { action: "wait", reason: "Pipeline: task is paused or pausing" };
      }
      if (context.attempt === "join-turn") return { action: "proceed" };
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
