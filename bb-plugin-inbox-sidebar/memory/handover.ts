// The only way a memory-on assistant's conversation changes: automatic rotation, `bb assistants rotate`
// and the composer all come here. It is the "New thread with…" flow (spawn, move automations, archive),
// run in one pass at a moment when nothing is in flight, with the old thread held while it runs. Like that
// flow, an obstacle after the spawn keeps the old thread live and says what to do; nothing resumes it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assistantConversationContext, repointAutomations, targetingAutomationsOf } from "../lib/assistant-conversation";
import { bootstrap } from "./prompt";
import type { MemoryService } from "./service";

type PromptInput = NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["input"]>[number];
type QueuedRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>[number];
type ListEntry = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

/**
 * Not now; nothing changed. `lasting` when waiting will not help (queued work, a live earlier chat): the
 * automatic path warns once instead of trying again.
 */
export class Busy extends Error {
  constructor(
    message: string,
    readonly lasting = false,
  ) {
    super(message);
  }
}

export type Place = {
  destination: { hostId: string; homePath: string };
  execution: {
    providerId: string;
    model: string;
    reasoningLevel: string;
    permissionMode: string;
    serviceTier?: string;
    executionInputSources?: unknown;
  };
  /** The composer's own blocks, after the agent-only view. */
  visible: PromptInput[];
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A row the public API can recreate as it is: an ordinary message, not scheduled, failed or part of a group. */
function plain(rows: QueuedRow[], k: number): boolean {
  const row = rows[k];
  return (
    row.initiator !== "system" &&
    row.payload.kind === "inline" &&
    row.sendAt === null &&
    row.failureReason === null &&
    !row.groupWithNext &&
    !rows[k - 1]?.groupWithNext
  );
}

/** Not running a turn: a failed turn, such as a context overflow, is a main reason to move on. */
const settled = (status: string) => status === "idle" || status === "error";
/** Work in flight. Plan mode is a mode, not work; a goal counts on its own. */
const working = ({ activity: a }: ListEntry) => a.activeWorkflowCount + a.activeBackgroundAgentCount + a.activeBackgroundCommandCount > 0;
/** What bb's archive takes along with a thread: its children, lifecycle dependents and hidden source threads. */
const takenWith = (id: string) => (t: ListEntry) =>
  t.parentThreadId === id || t.lifecycleOwnerThreadId === id || (t.sourceThreadId === id && t.visibility === "hidden");

/**
 * Null when the old thread and everything its archive takes can be archived now, else why not. Each of
 * those must be settled, and quiet long enough that no report to its parent is still on its way.
 */
async function oldBusy(svc: MemoryService, old: string): Promise<Busy | null> {
  const sdk = svc.bb.sdk.threads;
  // List entries carry the activity counters and the links; `get` has neither.
  const { projectId } = await sdk.get({ threadId: old });
  const all = await sdk.list({ projectId, includeHidden: true, archived: false });
  const root = all.find((t) => t.id === old);
  if (!root || !settled(root.status) || working(root)) return new Busy("The conversation is busy");
  // A goal keeps the chat going on its own; waiting 30 seconds will not end it.
  if (root.activity.activeGoalCount > 0) return new Busy("The main chat has an active goal", true);
  const now = Date.now();
  const seen = new Set([old]);
  for (let parents = [old]; parents.length > 0; ) {
    const taken = parents.flatMap((id) => all.filter(takenWith(id))).filter((t) => !seen.has(t.id));
    for (const t of taken) {
      seen.add(t.id);
      if (!settled(t.status)) return new Busy(`Child ${t.id} is ${t.status}`);
      if (working(t) || t.activity.activeGoalCount > 0 || t.queuedWork !== "none") return new Busy(`Child ${t.id} still has work`);
      if (now - t.updatedAt < svc.timing.quietMs) return new Busy(`Child ${t.id} just changed`);
    }
    parents = taken.map((t) => t.id);
  }
  const rows = await sdk.queuedMessages.list({ threadId: old });
  if (rows.length > 0) return new Busy(`Messages are queued on ${old}: ${rows.map((r) => r.id).join(", ")}`, true);
  return null;
}

/** Null when the main chat `old` can move now, else why not. */
async function safeMoment(svc: MemoryService, identity: string, old: string): Promise<Busy | null> {
  const s = svc.state(identity);
  // A wake-up from before the last handover must not move a chat that already moved.
  if (s.main !== old) return new Busy(`${old} is not the main chat`, true);
  if (s.previous.length > 0) {
    return new Busy(`Old conversation ${s.previous.join(", ")} is still live from an earlier rotation. Archive it to resume rotation.`, true);
  }
  return oldBusy(svc, old);
}

/** The old thread's own machine, home and settings, for a rotation nobody composed. */
async function samePlace(svc: MemoryService, old: string): Promise<Place> {
  const context = await assistantConversationContext(svc.bb, old);
  const [place, options] = await Promise.all([
    context.destination(context.env.hostId),
    svc.bb.sdk.threads.defaultExecutionOptions({ threadId: old }),
  ]);
  if (!place.ready) throw new Error(place.reason ?? "The assistant's home is not ready");
  if (!place.providerAvailable || !options) throw new Error(`${context.thread.providerId} is not available on the assistant's machine`);
  return {
    destination: { hostId: place.hostId, homePath: place.homePath },
    execution: {
      providerId: context.thread.providerId,
      model: options.model,
      reasoningLevel: options.reasoningLevel,
      permissionMode: options.permissionMode,
      serviceTier: options.serviceTier,
    },
    visible: [],
  };
}

/**
 * Move the main chat to a new thread whose first message carries the view. `composer` is the user's
 * "New thread with…" choice; without it the new thread runs where the old one did. Refusals before the
 * spawn throw `Busy` with nothing changed; after it, the result's `warning` says what is left to do.
 */
export async function handover(
  svc: MemoryService,
  { identity, oldThreadId: old, composer }: { identity: string; oldThreadId: string; composer?: Place },
): Promise<{ newThreadId: string; warning?: string }> {
  if (svc.ops.has(identity)) throw new Busy("A conversation change for this assistant is already running");
  const op = (async () => {
    // Before the hold, so a wait for summaries never holds the user's messages.
    await svc.catchUp(identity, old);
    if (!(await svc.readyWithin(identity, svc.timing.readyCapMs))) throw new Busy(svc.notReady(identity));
    const busy = await safeMoment(svc, identity, old);
    if (busy) throw busy;
    svc.holds.add(old);
    try {
      // A message may have started work between the check and the hold.
      await svc.catchUp(identity, old);
      if (!svc.ready(identity)) throw new Busy(svc.notReady(identity));
      const again = await safeMoment(svc, identity, old);
      if (again) throw again;
      const context = await assistantConversationContext(svc.bb, old);
      if (composer) await context.validate(composer.destination.hostId, composer.destination.homePath);
      const { destination, execution, visible } = composer ?? (await samePlace(svc, old));
      // Listed before spawning, so an unreachable automations plugin refuses instead of stranding jobs.
      await targetingAutomationsOf(svc.bb, old);
      const fresh = await svc.bb.sdk.threads.spawn({
        projectId: context.thread.projectId,
        ...execution,
        input: [{ type: "text", text: bootstrap(svc.chat(identity).viewLines()), visibility: "agent-only" }, ...visible],
        title: context.thread.title ?? undefined,
        environment: { type: "host", hostId: destination.hostId, workspace: { type: "unmanaged", path: destination.homePath } },
      } as Parameters<typeof svc.bb.sdk.threads.spawn>[0]);
      svc.update(identity, { main: fresh.id, previous: [...svc.state(identity).previous, old] });
      const warning = await finish(svc, identity, old, fresh.id);
      if (warning === undefined) return { newThreadId: fresh.id };
      svc.warn(identity, warning);
      return { newThreadId: fresh.id, warning };
    } finally {
      svc.holds.delete(old);
      // Held messages are asked again: on an old thread that stayed live they now go out there.
      void svc.bb.experimental_hooks.recheck("message.dispatch").catch(() => {});
    }
  })().finally(() => svc.ops.delete(identity));
  svc.ops.set(identity, op);
  return op;
}

/**
 * After the spawn: once the new thread runs (automations disable themselves on a target that is not
 * running yet), move automations, log the old thread's last events, move held messages, check the old
 * thread is still done and archive it. Archiving drops its queued rows and may prune its events, so both
 * come first, and nothing waits between the last check and the archive.
 * Undefined when the old thread is archived, else what keeps it live and what to do.
 */
async function finish(svc: MemoryService, identity: string, old: string, fresh: string): Promise<string | undefined> {
  const kept = (why: string, action = "Archive it to resume rotation.") => `Old conversation ${old} kept live: ${why}. ${action}`;
  try {
    const started = await runnable(svc, fresh);
    if (started !== "ok") return kept(`new conversation ${fresh} ${started === "failed" ? "failed to start" : "has not started in time"}`);
    const stuck = await repointAutomations(svc.bb, await targetingAutomationsOf(svc.bb, old), fresh);
    if (stuck.length > 0) return kept(`automations still target it (${stuck.join("; ")})`, "Archive it, or move its automations, to resume rotation.");
    await svc.catchUp(identity, old);
    await moveHeld(svc, old, fresh);
    const busy = await oldBusy(svc, old);
    if (busy) return kept(busy.message, busy.lasting ? "Send or remove them, then archive it, to resume rotation." : "Archive it when that work is done to resume rotation.");
    await svc.bb.sdk.threads.archive({ threadId: old });
    svc.update(identity, { previous: svc.state(identity).previous.filter((id) => id !== old) });
    return undefined;
  } catch (error) {
    return kept(message(error));
  }
}

/** Recreate the old thread's plain rows on the new one, where its own settings apply. */
async function moveHeld(svc: MemoryService, old: string, fresh: string): Promise<void> {
  const sdk = svc.bb.sdk.threads.queuedMessages;
  const rows = await sdk.list({ threadId: old });
  for (const [k, row] of rows.entries()) {
    if (!plain(rows, k)) continue;
    await sdk.create({ threadId: fresh, input: row.content, ...(row.senderThreadId ? { senderThreadId: row.senderThreadId } : {}) });
    await sdk.delete({ threadId: old, queuedMessageId: row.id });
  }
}

/** Active or idle: a target automations accept. A failed start is final, so it ends the wait at once. */
async function runnable(svc: MemoryService, threadId: string): Promise<"ok" | "failed" | "late"> {
  for (const deadline = Date.now() + svc.timing.runnableMs; ; ) {
    const { status } = await svc.bb.sdk.threads.get({ threadId });
    if (status === "active" || status === "idle") return "ok";
    if (status === "error") return "failed";
    if (Date.now() >= deadline || svc.disposed) return "late";
    await sleep(svc.timing.pollMs);
  }
}
