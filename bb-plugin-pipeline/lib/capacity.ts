import type {
  BbPluginApi,
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import type { CardStore } from "./store";
import { createTaskThreads, isThreadNotFound } from "./task-threads";
import { ownerThread } from "./card";
import { pauseInstruction } from "./control-prompts";

type Thread = MessageDispatchHookContext["thread"];

const TASK_LIMIT = 2;
const PAUSE_WAIT: MessageDispatchHookDecision = {
  action: "wait",
  reason: "Pipeline: task is paused or pausing",
};

export function createPipelineCapacity(bb: BbPluginApi, store: CardStore) {
  const { sdk } = bb;
  const { resolver } = createTaskThreads(bb, store);

  return {
    async decide(context: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> {
      const taskFor = resolver();
      const task = await taskFor(context.thread);
      if (task === null) return { action: "proceed" };

      const pauseGate = async (): Promise<MessageDispatchHookDecision | null> => {
        while (true) {
          const card = store.get(task.cardId);
          if (card === null || card.runState === "running") return null;
          if (card.runState !== "pause_requested") return PAUSE_WAIT;
          if (context.thread.id === ownerThread(card) && context.input.text === pauseInstruction(card)) {
            return null;
          }
          if (context.thread.status === "pending") return PAUSE_WAIT;
          // Core's worker completion notices have no sender thread.
          if (context.initiator === "system") return null;
          if (context.senderThreadId === null || context.senderThreadId === "mixed") return PAUSE_WAIT;

          const revision = card.revision;
          let senderTask: Awaited<ReturnType<typeof taskFor>>;
          try {
            const sender = await sdk.threads.get({
              threadId: context.senderThreadId,
              experimental_includeDeleted: true,
            });
            senderTask = await taskFor(sender);
          } catch (cause) {
            if (!isThreadNotFound(cause)) throw cause;
            if (store.get(task.cardId)?.revision !== revision) continue;
            return PAUSE_WAIT;
          }
          if (store.get(task.cardId)?.revision !== revision) continue;
          if (senderTask?.cardId !== card.id) return PAUSE_WAIT;

          let pauseRequestedAt: number | undefined;
          const history = store.history(card.id);
          for (let index = history.length - 1; index >= 0; index -= 1) {
            if (history[index]?.kind === "pause_requested") {
              pauseRequestedAt = history[index]!.at;
              break;
            }
          }
          if (context.queuedMessages.some((entry) =>
            pauseRequestedAt === undefined || entry.createdAt < pauseRequestedAt
          )) return PAUSE_WAIT;
          return null;
        }
      };

      const initialPause = await pauseGate();
      if (initialPause !== null) return initialPause;
      if (context.attempt === "join-turn") return { action: "proceed" };
      if (context.host === null) return { action: "reject", message: "Pipeline work requires a machine" };

      const running = await sdk.threads.listRunning({ experimental_includeDispatchOccupancy: true });
      const occupied = new Set<string>();
      for (const entry of running) {
        if (entry.hostId !== context.host.id) continue;
        const thread = await sdk.threads.get({ threadId: entry.id, experimental_includeDeleted: true });
        const other = await taskFor(thread);
        if (other?.projectId !== task.projectId) continue;
        if (other.cardId === task.cardId) {
          return (await pauseGate()) ?? { action: "proceed" };
        }
        occupied.add(other.cardId);
      }
      if (occupied.size >= TASK_LIMIT) {
        return { action: "wait", reason: `Pipeline: ${TASK_LIMIT} tasks running on ${context.host.name}` };
      }
      return (await pauseGate()) ?? { action: "proceed" };
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
