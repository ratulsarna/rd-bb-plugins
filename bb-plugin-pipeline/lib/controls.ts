import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { ownerThread, PAUSE_DELIVERY_PENDING, requireStarted } from "./card";
import { isResumeInstruction, pauseInstruction, resumeInstruction } from "./control-prompts";
import type { Card, CardPatch, CardStore } from "./store";
import type { PipelineService } from "./service";
import { createTaskThreads, isThreadNotFound, type TaskThread } from "./task-threads";

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
type QueueEntry = PluginThreadEventPayloads["message.cancelled"]["entry"];
const containsInstruction = (entry: QueueEntry, text: string) =>
  entry.content.length === 1 && entry.content[0]?.type === "text" && entry.content[0].text === text;

export function createPipelineControls(
  bb: BbPluginApi,
  store: CardStore,
  service: Pick<PipelineService, "launch" | "retry" | "onThreadQueueChanged" | "launchSettled">,
  options: { getPromptDocuments?(card: Card): Promise<Record<string, string>> } = {},
) {
  const tasks = createTaskThreads(bb, store);
  const operations = new Map<string, Promise<unknown>>();
  const required = (id: string) => {
    const card = store.get(id);
    if (card === null) throw new Error(`unknown card ${id}`);
    return card;
  };
  const update = (id: string, patch: CardPatch, kind?: string): Card => {
    const card = store.update(id, patch, kind === undefined ? undefined : { kind, source: "control" });
    bb.realtime.publish("cards:changed", { projectId: card.projectId });
    return card;
  };
  async function serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous: Promise<unknown> = operations.get(id) ?? Promise.resolve(required(id));
    const next = previous.catch(() => required(id)).then(work);
    operations.set(id, next);
    try { return await next; }
    finally { if (operations.get(id) === next) operations.delete(id); }
  }
  const controlRows = async (card: Card) => (await bb.sdk.threads.queue.list())
    .filter((entry) => entry.threadId === ownerThread(card) && containsInstruction(entry, pauseInstruction(card)));

  async function currentOwner(card: Card): Promise<TaskThread | null> {
    const threadId = ownerThread(card);
    if (threadId === null) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId, experimental_includeDeleted: true });
      if (thread.deletedAt === null) return thread;
    } catch (cause) {
      if (!isThreadNotFound(cause)) throw cause;
    }
    if (ownerThread(required(card.id)) === threadId) {
      update(card.id, { [card.ownerRole === "lead" ? "leadThreadId" : "intakeThreadId"]: null }, "thread_gone");
    }
    return null;
  }

  async function settle(id: string): Promise<Card> {
    const before = required(id);
    if (before.runState === "running") return before;
    if (before.runState === "pause_requested") {
      const owner = await currentOwner(before);
      if (owner !== null) {
        const current = required(id);
        if (current.runState !== before.runState || current.pauseRequestId !== before.pauseRequestId) return current;
        const failure = owner.archivedAt !== null ? "Restore the owning thread to finish pausing, or stop now."
          : owner.status === "error" ? "Owner thread failed before acknowledging pause. Retry pause or stop now." : null;
        return failure !== null && current.controlError !== failure ? update(id, { controlError: failure }) : current;
      }
    }
    const occupied = await tasks.occupied(id);
    const current = required(id);
    if (current.runState !== before.runState || current.pauseRequestId !== before.pauseRequestId) return current;
    if (occupied.length === 0 && current.runState !== "paused" &&
      (current.runState !== "stopping" || current.controlError === null)) {
      return update(id, { runState: "paused", ...(current.runState === "pause_requested" ? { controlError: null } : {}) }, "paused");
    }
    if (occupied.length > 0 && current.runState === "paused") {
      return update(id, { runState: "pausing" });
    }
    return current;
  }

  async function deliverPause(card: Card): Promise<void> {
    const threadId = ownerThread(card);
    if (threadId === null) throw new Error("The owner is still starting. Retry pause when its thread is linked.");
    const existing = await controlRows(card);
    if (existing.length === 0) {
      await bb.sdk.threads.send({
        threadId, mode: "steer", input: [{ type: "text", text: pauseInstruction(card), mentions: [] }],
      });
    }
  }

  async function pause(id: string): Promise<Card> {
    return serialize(id, async () => {
      let card = required(id);
      requireStarted(card, "pausing it");
      if (card.column === "done") throw new Error("Completed tasks cannot be paused");
      if (card.runState !== "running" && !(card.runState === "pause_requested" && card.controlError !== null)) return card;
      card = update(id, {
        runState: "pause_requested", pauseRequestId: card.runState === "running" ? randomUUID() : card.pauseRequestId ?? randomUUID(),
        controlError: PAUSE_DELIVERY_PENDING,
      }, card.runState === "running" ? "pause_requested" : "pause_retried");
      try {
        const occupied = await tasks.occupied(id);
        const thread = await currentOwner(required(id));
        if (occupied.length === 0 && (thread === null || thread.status === "pending")) {
          return update(id, { runState: "paused", controlError: null }, "paused");
        }
        await deliverPause(required(id));
        update(id, { controlError: null });
        await bb.experimental_hooks.recheck("message.dispatch");
      } catch (cause) {
        update(id, { controlError: errorMessage(cause) });
      }
      return required(id);
    });
  }

  async function acknowledge(input: { cardId?: string; threadId?: string; requestId: string }): Promise<Card> {
    const found = input.cardId === undefined
      ? input.threadId === undefined ? null : store.getByThread(input.threadId)
      : store.get(input.cardId);
    if (found === null) throw new Error("unknown Pipeline task");
    requireStarted(found, "acknowledging a pause");
    if (input.threadId === undefined || input.threadId !== ownerThread(found)) {
      throw new Error("Only the current intake or lead can acknowledge a pause");
    }
    if (found.pauseRequestId !== input.requestId || found.runState === "running" || found.runState === "stopping") {
      throw new Error("This pause request is no longer current");
    }
    if (found.runState === "pause_requested") {
      update(found.id, { runState: "pausing", controlError: null }, "pause_acknowledged");
    }
    return settle(found.id);
  }

  const taskThreadIds = (card: Card, occupied: TaskThread[]) => new Set([
    ...occupied.map((thread) => thread.id),
    ...[card.intakeThreadId, card.leadThreadId].filter((id) => id !== null),
  ]);

  // Stopping a pending thread abandons its start. Stop keeps that start for Resume; removal does not.
  async function halt(card: Card, occupied: TaskThread[], keepPending: boolean): Promise<string[]> {
    const failures: string[] = [];
    for (const threadId of taskThreadIds(card, occupied)) {
      const busy = occupied.some((entry) => entry.id === threadId);
      try {
        const thread = await bb.sdk.threads.get({ threadId, experimental_includeDeleted: true });
        if ((keepPending && thread.status === "pending") || (thread.deletedAt !== null && !busy)) continue;
        await bb.sdk.threads.stop({ threadId });
      } catch (cause) {
        if (isThreadNotFound(cause) && !busy) continue;
        failures.push(`${threadId}: could not stop: ${errorMessage(cause)}`);
      }
    }
    return failures;
  }

  async function stop(id: string): Promise<Card> {
    return serialize(id, async () => {
      const card = required(id);
      requireStarted(card, "stopping it");
      update(id, { runState: "stopping", controlError: null }, "stop_requested");
      try {
        const failures = await halt(card, await tasks.occupied(id), true);
        if (failures.length > 0) update(id, { controlError: failures.join("; ") });
        return await settle(id);
      } catch (cause) {
        return update(id, { controlError: errorMessage(cause) });
      }
    });
  }

  // Removal always removes the card; whatever cleanup could not do comes back as warnings.
  async function remove(id: string): Promise<{ removed: true; warnings: string[] }> {
    return serialize(id, async () => {
      const { projectId } = required(id);
      const warnings: string[] = [];
      const attempt = async <T>(failure: string, fallback: T, work: () => Promise<T>): Promise<T> => {
        try { return await work(); } catch (cause) { warnings.push(`${failure}: ${errorMessage(cause)}`); return fallback; }
      };
      try {
        // Holds the card's queued messages and new launches until cleanup ends; a missing card releases both.
        update(id, { runState: "stopping", controlError: null }, "stop_requested");
        await service.launchSettled(id);
        const card = required(id);
        const occupied = await attempt("could not list running threads", [], () => tasks.occupied(id));
        // Clearing a goal restores a stopped runtime, so goals go first and the stop comes last.
        for (const threadId of taskThreadIds(card, occupied)) {
          try {
            const { goal } = await bb.sdk.threads.timeline({ threadId, summaryOnly: "true" });
            if (goal?.status === "active") await bb.sdk.threads.clearGoal({ threadId });
          } catch (cause) {
            if (!isThreadNotFound(cause)) warnings.push(`${threadId}: could not clear its goal: ${errorMessage(cause)}`);
          }
        }
        warnings.push(...await halt(card, occupied, false));
        for (const entry of await attempt("could not check queued messages", [], () => tasks.queued(id))) {
          await attempt(`${entry.threadId}: could not delete a queued message`, undefined, () =>
            bb.sdk.threads.queuedMessages.delete({ threadId: entry.threadId, queuedMessageId: entry.id }));
        }
        for (const thread of await attempt("could not confirm threads stopped", [], () => tasks.occupied(id))) {
          warnings.push(`${thread.id}: still running`);
        }
      } finally {
        store.remove(id);
        bb.realtime.publish("cards:changed", { projectId });
      }
      return { removed: true as const, warnings };
    });
  }

  async function resume(id: string): Promise<Card> {
    return serialize(id, async () => {
      const card = required(id);
      requireStarted(card, "resuming it");
      if (card.runState === "running") return card;
      if (card.runState !== "paused") throw new Error("Wait for the task to finish pausing before resuming");
      try {
        if ((await tasks.occupied(id)).length > 0) throw new Error("Task work is still running; finish pausing first");
        for (const entry of await controlRows(card)) {
          await bb.sdk.threads.queuedMessages.delete({ threadId: entry.threadId, queuedMessageId: entry.id });
        }
        const thread = await currentOwner(required(id));
        if (thread?.archivedAt != null) throw new Error("Restore the owning thread before resuming");
        // Keep the token until dispatch is durable so startup can recover an interrupted resume.
        const running = update(id, { runState: "running", pauseRequestId: card.pauseRequestId ?? randomUUID(), controlError: null }, "resumed");
        if (thread === null) {
          await service.launch(running.id, running.ownerRole);
        } else if (thread.status === "pending") {
          await service.onThreadQueueChanged(thread);
          if (required(id).launchError !== null) await service.retry(id);
        } else {
          const documents = await options.getPromptDocuments?.(card);
          await bb.sdk.threads.send({ threadId: thread.id, mode: "auto", input: [{ type: "text", text: resumeInstruction(card, documents), mentions: [] }] });
        }
        update(id, { pauseRequestId: null });
        await bb.experimental_hooks.recheck("message.dispatch");
        return required(id);
      } catch (cause) {
        const current = required(id);
        update(id, { runState: current.runState === "running" ? "pausing" : current.runState, pauseRequestId: card.pauseRequestId, controlError: errorMessage(cause) });
        return settle(id);
      }
    });
  }

  async function onActivity(thread: TaskThread, started = false): Promise<void> {
    const task = await tasks.resolver()(thread);
    if (task === null || store.get(task.cardId) === null) return;
    if (!required(task.cardId).startRequested) return;
    if (started && ["stopping", "paused"].includes(required(task.cardId).runState)) {
      await stop(task.cardId);
      return;
    }
    await settle(task.cardId);
  }

  function onMessageCancelled(entry: QueueEntry): void {
    const card = store.getByThread(entry.threadId);
    if (card?.runState === "pause_requested" && ownerThread(card) === entry.threadId &&
      containsInstruction(entry, pauseInstruction(card))) {
      update(card.id, { controlError: "Pause instruction cancelled. Retry pause or stop now." });
    }
  }

  async function startup(): Promise<void> {
    for (const card of store.listControlled()) {
      try {
        if (card.runState === "running") {
          const thread = await currentOwner(card);
          const queue = await bb.sdk.threads.queue.list();
          const delivered = (await tasks.occupied(card.id)).length > 0 || queue.some((entry) =>
            entry.threadId === thread?.id && (thread.status === "pending" ||
              (entry.content.length === 1 && entry.content[0]?.type === "text" && isResumeInstruction(card, entry.content[0].text))));
          const current = required(card.id);
          if (current.runState !== "running" || current.pauseRequestId !== card.pauseRequestId) continue;
          update(card.id, delivered || current.column === "done"
            ? { pauseRequestId: null, controlError: null }
            : { runState: "paused", controlError: "Resume was interrupted. Resume again to continue." });
        } else if (card.runState === "stopping") await stop(card.id);
        else if (card.runState === "pause_requested" && card.controlError !== null) await pause(card.id);
        else await settle(card.id);
      } catch (cause) {
        bb.log.warn(`Could not recover task ${card.id}: ${errorMessage(cause)}`);
      }
    }
  }

  return { pause, resume, stop, remove, acknowledge, onActivity, onMessageCancelled, startup };
}

export type PipelineControls = ReturnType<typeof createPipelineControls>;
