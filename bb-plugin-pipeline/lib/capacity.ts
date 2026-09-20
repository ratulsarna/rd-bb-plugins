import type {
  BbPluginApi,
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import type { Card, CardStore } from "./store";
import type { MachineQueue } from "./contract";
import { createTaskThreads, isThreadNotFound } from "./task-threads";
import { ownerThread } from "./card";
import { pauseInstruction } from "./control-prompts";

type Thread = MessageDispatchHookContext["thread"];
type Host = NonNullable<MessageDispatchHookContext["host"]>;
type QueueEntry = PluginThreadEventPayloads["message.queued"]["entry"];
type QueuedTask = { entry: QueueEntry; thread: Thread; cardId: string; hostId: string | null; interaction: boolean };

const TASK_LIMIT = 2;
const CAPACITY_REASON = `Pipeline: ${TASK_LIMIT} tasks running`;
const NEXT_REASON = "Pipeline: Run next has priority";
const PRIORITY_YIELD_MS = 5_000;
const PAUSE_WAIT: MessageDispatchHookDecision = {
  action: "wait",
  reason: "Pipeline: task is paused or pausing",
};

function hostBlocker(host: Host | undefined): string | null {
  if (host === undefined || host.status !== "connected") return "Machine offline";
  if (host.lifecycle.suspendedAt !== null || ["suspending", "suspended", "resuming"].includes(host.lifecycle.phase)) return "Machine suspended or resuming";
  return null;
}

export function createPipelineCapacity(bb: BbPluginApi, store: CardStore) {
  const { sdk } = bb;
  const { resolver, occupancy } = createTaskThreads(bb, store);

  function ownsCapacityWait(entry: QueueEntry): boolean {
    return entry.waitingOn?.kind === "plugin" && entry.waitingOn.pluginId === bb.pluginId &&
      [CAPACITY_REASON, NEXT_REASON].includes(entry.waitingOn.reason);
  }

  async function queuedTasks(projectId: string, cardId?: string): Promise<QueuedTask[]> {
    const taskFor = resolver();
    const environments = new Map<string, Promise<string | null>>();
    const rows: QueuedTask[] = [];
    const threadIds = new Set((await sdk.threads.queue.list()).map((entry) => entry.threadId));
    for (const threadId of threadIds) {
      let thread: Thread;
      try { thread = await sdk.threads.get({ threadId, experimental_includeDeleted: true }); }
      catch (cause) { if (isThreadNotFound(cause)) continue; throw cause; }
      const task = await taskFor(thread);
      if (task?.projectId !== projectId || (cardId !== undefined && task.cardId !== cardId)) continue;
      // The global list is creation-ordered; grouping follows the reorderable per-thread queue.
      const entries = await sdk.threads.queuedMessages.list({ threadId });
      if (entries.length === 0) continue;
      let hostId = store.get(task.cardId)?.hostId ?? null;
      if (thread.environmentId !== null) {
        let host = environments.get(thread.environmentId);
        if (host === undefined) {
          host = sdk.environments.get({ environmentId: thread.environmentId }).then((environment) => environment.hostId);
          environments.set(thread.environmentId, host);
        }
        hostId = await host;
      }
      const pending = await sdk.threads.interactions.list({ threadId });
      const interaction = pending.some((item) => item.turnId !== null && (item.status === "pending" || item.status === "resolving"));
      for (const entry of entries) rows.push({ entry, thread, cardId: task.cardId, hostId, interaction });
    }
    return rows;
  }

  function taskRef(cardId: string, thread: Thread) {
    const card = store.get(cardId);
    return { cardId, title: card?.title ?? thread.title ?? "Removed task", threadId: thread.id };
  }

  function reasons(row: QueuedTask, card: Card | null, host: Host | undefined): string[] {
    const result = new Set<string>();
    if (card !== null && card.runState !== "running") {
      result.add({ pause_requested: "Pause requested", pausing: "Pausing", paused: "Paused", stopping: "Stopping" }[card.runState]);
    }
    const blocked = hostBlocker(host);
    if (blocked !== null) result.add(blocked);
    if (row.thread.deletedAt !== null) result.add("Thread deleted");
    else if (row.thread.archivedAt !== null) result.add("Thread archived");
    if (row.interaction) result.add("Waiting for your answer");
    if (row.entry.failureReason !== null) result.add(`Dispatch failed: ${row.entry.failureReason}`);
    const wait = row.entry.waitingOn;
    if (row.entry.sendAt !== null && row.entry.sendAt > Date.now() && !ownsCapacityWait(row.entry)) {
      result.add(`Scheduled for ${new Date(row.entry.sendAt).toISOString()}`);
    }
    if (wait?.kind === "plugin") {
      result.add(ownsCapacityWait(row.entry)
        ? wait.reason === CAPACITY_REASON ? "Waiting for capacity" : "Waiting behind Run next"
        : `${wait.pluginId}: ${wait.reason}`);
    } else if (wait !== null) {
      const labels = { time: "Scheduled", "thread-busy": "Thread busy", stopping: "Thread stopping", "turn-starting": "Thread starting", provisioning: "Preparing workspace", "host-offline": "Machine offline", interaction: "Waiting for your answer" };
      result.add(labels[wait.kind]);
    }
    if (result.size === 0) result.add("Waiting to dispatch");
    return [...result];
  }

  async function snapshot(projectId: string): Promise<MachineQueue[]> {
    const [hosts, occupied, queued] = await Promise.all([sdk.hosts.list(), occupancy(), queuedTasks(projectId)]);
    const machines = new Map<string, MachineQueue>();
    function machine(hostId: string): MachineQueue {
      let value = machines.get(hostId);
      if (value === undefined) {
        value = { hostId, hostName: hosts.find((host) => host.id === hostId)?.name ?? hostId, limit: TASK_LIMIT, occupied: [], waiting: [], nextCardId: store.getRunNext(projectId, hostId) };
        machines.set(hostId, value);
      }
      return value;
    }
    for (const card of store.list(projectId, true)) if (card.hostId !== null) machine(card.hostId);
    for (const { thread, task, hostId } of occupied) {
      if (task.projectId !== projectId || hostId === null) continue;
      const value = machine(hostId);
      if (!value.occupied.some((item) => item.cardId === task.cardId)) value.occupied.push(taskRef(task.cardId, thread));
    }
    for (const row of queued) {
      if (row.hostId === null) continue;
      const value = machine(row.hostId);
      const card = store.get(row.cardId);
      const labels = reasons(row, card, hosts.find((host) => host.id === row.hostId));
      const existing = value.waiting.find((item) => item.cardId === row.cardId);
      if (existing !== undefined) existing.reasons = [...new Set([...existing.reasons, ...labels])];
      else value.waiting.push({ ...taskRef(row.cardId, row.thread), reasons: labels,
        canRunNext: card !== null && card.runState === "running" && card.column !== "done" && card.hostId === row.hostId && !value.occupied.some((item) => item.cardId === row.cardId),
      });
    }
    for (const value of machines.values()) {
      if (value.nextCardId !== null && !value.waiting.some((item) => item.cardId === value.nextCardId && item.canRunNext)) {
        value.nextCardId = null;
      }
    }
    return [...machines.values()];
  }

  async function setRunNext(cardId: string, enabled: boolean): Promise<void> {
    const card = store.get(cardId);
    if (card === null) throw new Error(`unknown card ${cardId}`);
    if (enabled) {
      const queue = await snapshot(card.projectId);
      const current = store.get(cardId);
      if (current === null || current.runState !== "running" || current.column === "done" ||
        !queue.some((machine) => machine.waiting.some((item) => item.cardId === cardId && item.canRunNext))) {
        throw new Error("Run next requires a queued task that is not running or paused");
      }
      store.setRunNext(cardId);
    } else store.clearRunNext(cardId);
    bb.realtime.publish("cards:changed", { projectId: card.projectId });
    await bb.experimental_hooks.recheck("message.dispatch");
  }

  async function nextReady(projectId: string, hostId: string, currentCardId: string, occupied: ReadonlySet<string>): Promise<boolean> {
    const nextId = store.getRunNext(projectId, hostId);
    if (nextId === null || nextId === currentCardId || occupied.has(nextId)) return false;
    const card = store.get(nextId);
    if (card === null || card.runState !== "running" || card.column === "done") return false;
    const rows = await queuedTasks(projectId, nextId);
    // A group can run only when every member can run; do not prioritize a ready tail of a held group.
    const groups = new Map<string, QueuedTask[][]>();
    for (const row of rows) {
      let list = groups.get(row.thread.id);
      if (list === undefined) { list = []; groups.set(row.thread.id, list); }
      const last = list.at(-1);
      if (last?.at(-1)?.entry.groupWithNext) last.push(row);
      else list.push([row]);
    }
    const current = store.get(nextId);
    if (store.getRunNext(projectId, hostId) !== nextId || current?.runState !== "running" || current.column === "done") return false;
    return [...groups.values()].some((list) => list.some((group) => group.every((row) =>
      row.hostId === hostId && row.thread.deletedAt === null && row.thread.archivedAt === null &&
      ["idle", "pending", "error"].includes(row.thread.status) && !row.interaction &&
      row.entry.failureReason === null && (row.entry.sendAt === null || row.entry.sendAt <= Date.now() ||
        (row.entry.waitingOn?.kind === "plugin" && row.entry.waitingOn.reason === NEXT_REASON)) && ownsCapacityWait(row.entry),
    )));
  }

  async function onStarted(thread: Thread): Promise<void> {
    const task = await resolver()(thread);
    if (task !== null && store.clearRunNext(task.cardId)) {
      bb.realtime.publish("cards:changed", { projectId: task.projectId });
      await bb.experimental_hooks.recheck("message.dispatch");
    }
  }

  async function onQueueChanged(thread: Thread, entry?: QueueEntry): Promise<void> {
    const task = await resolver()(thread);
    const card = task === null ? null : store.get(task.cardId);
    if (card?.hostId == null || store.getRunNext(card.projectId, card.hostId) !== card.id) return;
    if (entry !== undefined && ownsCapacityWait(entry)) return;
    if ((await queuedTasks(card.projectId, card.id)).length === 0) store.clearRunNext(card.id);
    await bb.experimental_hooks.recheck("message.dispatch");
  }

  async function startup(): Promise<void> {
    for (const choice of store.listRunNext()) {
      const queue = await snapshot(choice.projectId);
      if (!queue.some((machine) => machine.nextCardId === choice.cardId)) store.clearRunNext(choice.cardId);
    }
  }

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

      const occupied = new Set<string>();
      for (const { task: other } of await occupancy(context.host.id)) {
        if (other.projectId !== task.projectId) continue;
        if (other.cardId === task.cardId) {
          return (await pauseGate()) ?? { action: "proceed" };
        }
        occupied.add(other.cardId);
      }
      if (occupied.size >= TASK_LIMIT) {
        return { action: "wait", reason: CAPACITY_REASON };
      }
      const priorYield = context.queuedMessages.filter((entry) => ownsCapacityWait(entry) &&
        entry.waitingOn?.kind === "plugin" && entry.waitingOn.reason === NEXT_REASON && entry.sendAt !== null);
      const deadline = priorYield.length === 0 ? Date.now() + PRIORITY_YIELD_MS : Math.min(...priorYield.map((entry) => entry.sendAt!));
      if (deadline > Date.now() && hostBlocker(context.host) === null && await nextReady(task.projectId, context.host.id, task.cardId, occupied)) {
        // One bounded yield: an unobservable core blocker must not hold the rest of the queue forever.
        return { action: "wait", reason: NEXT_REASON, sendAt: deadline };
      }
      return (await pauseGate()) ?? { action: "proceed" };
    },
    snapshot,
    setRunNext,
    onStarted,
    onQueueChanged,
    startup,

    async publish(thread: Thread): Promise<void> {
      const task = await resolver()(thread);
      if (task === null) return;
      bb.realtime.publish("cards:changed", { projectId: task.projectId });
    },
  };
}

export type PipelineCapacity = ReturnType<typeof createPipelineCapacity>;
