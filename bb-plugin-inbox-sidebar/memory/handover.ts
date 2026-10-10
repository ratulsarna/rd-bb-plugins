// The only way a memory-on assistant's conversation changes: automatic rotation, `bb assistants rotate`
// and the composer all come here. It is the "New thread with…" flow (spawn, move automations, archive),
// run only at a moment when nothing is in flight, with the old thread held while it runs.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assistantConversationContext, repointAutomations, targetingAutomationsOf } from "../lib/assistant-conversation";
import { bootstrap } from "./prompt";
import type { MemoryService } from "./service";
import { unfinished } from "./state";

type PromptInput = NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["input"]>[number];
type QueuedRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>[number];
type ListEntry = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

/** Not now: nothing changed, and the automatic path tries again later. */
export class Busy extends Error {}

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

function exclusive<T>(svc: MemoryService, identity: string, run: () => Promise<T>): Promise<T> {
  const op = run().finally(() => svc.ops.delete(identity));
  svc.ops.set(identity, op);
  return op;
}

function release(svc: MemoryService, threadId: string): void {
  // Held messages are asked again: on a thread that stayed live they now go out.
  if (svc.holds.delete(threadId)) void svc.bb.experimental_hooks.recheck("message.dispatch").catch(() => {});
}

/** A row the public API can recreate as it is: an ordinary message, not scheduled, not part of a group. */
function plain(rows: QueuedRow[], k: number): boolean {
  const row = rows[k];
  return row.initiator !== "system" && row.payload.kind === "inline" && row.sendAt === null && !row.groupWithNext && !rows[k - 1]?.groupWithNext;
}

/** Not running a turn: a failed turn, such as a context overflow, is a main reason to move on. */
const settled = (status: string) => status === "idle" || status === "error";
const working = (t: ListEntry) => Object.values(t.activity).some((n) => n > 0);

/**
 * Null when every descendant of `root` is done, else why not. Archiving takes the whole tree with it, so
 * each must be settled, and quiet long enough that no report to its parent is still on its way.
 */
async function childrenBusy(svc: MemoryService, root: string): Promise<string | null> {
  const now = Date.now();
  for (let parents = [root]; parents.length > 0; ) {
    const children = (await Promise.all(parents.map((id) => svc.bb.sdk.threads.list({ parentThreadId: id, includeHidden: true })))).flat();
    for (const child of children) {
      if (!settled(child.status)) return `Child ${child.id} is ${child.status}`;
      if (working(child) || child.queuedWork !== "none") return `Child ${child.id} still has work`;
      if (now - child.updatedAt < svc.timing.quietMs) return `Child ${child.id} just changed`;
    }
    parents = children.map((child) => child.id);
  }
  return null;
}

/** Null when the old thread can move now, else why not. */
export async function safeMoment(svc: MemoryService, identity: string, old: string, { resuming }: { resuming: boolean }): Promise<string | null> {
  const s = svc.state(identity);
  const h = unfinished(s);
  if (resuming ? h?.old !== old : h) return "Another conversation change for this assistant is not finished";
  // A wake-up from before the last handover finished must not move a chat that already moved.
  if (!resuming && s.main !== old) return `${old} is not the main chat`;
  const sdk = svc.bb.sdk.threads;
  // The list entry carries the activity counters; `get` does not.
  const { projectId } = await sdk.get({ threadId: old });
  const root = (await sdk.list({ projectId, hasParent: false, includeHidden: true })).find((t) => t.id === old);
  if (!root || !settled(root.status) || working(root)) return "The conversation is busy";
  const children = await childrenBusy(svc, old);
  if (children) return children;
  // Nothing scheduled or grouped may be left behind; a resume moves the plain rows that arrived while held.
  const rows = await sdk.queuedMessages.list({ threadId: old });
  if (rows.some((_, k) => !(resuming && plain(rows, k)))) return "The conversation has queued messages";
  return null;
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
 * "New thread with…" choice; without it the new thread runs where the old one did.
 */
export async function handover(
  svc: MemoryService,
  { identity, oldThreadId: old, composer }: { identity: string; oldThreadId: string; composer?: Place },
): Promise<{ newThreadId: string; warning?: string }> {
  if (svc.ops.has(identity)) throw new Busy("A conversation change for this assistant is already running");
  return exclusive(svc, identity, async () => {
    // Before the hold, so a wait for summaries never holds the user's messages.
    await svc.catchUp(identity, old);
    if (!(await svc.readyWithin(identity, svc.timing.readyCapMs))) throw new Busy(svc.notReady(identity));
    const busy = await safeMoment(svc, identity, old, { resuming: false });
    if (busy) throw new Busy(busy);
    svc.holds.add(old);
    try {
      // A message may have started a turn between the check and the hold.
      if (!settled((await svc.bb.sdk.threads.get({ threadId: old })).status)) throw new Busy("The conversation is busy");
      await svc.catchUp(identity, old);
      if (!svc.ready(identity)) throw new Busy(svc.notReady(identity));
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
      svc.update(identity, { main: fresh.id, handover: { old, new: fresh.id, step: "spawned", at: Date.now() } });
      const warning = await complete(svc, identity);
      return warning === undefined ? { newThreadId: fresh.id } : { newThreadId: fresh.id, warning };
    } finally {
      release(svc, old);
    }
  });
}

/** Pick up an unfinished handover: at startup, and when its old or new thread changes state. */
export function resume(svc: MemoryService, identity: string): Promise<void> {
  if (svc.ops.has(identity)) return Promise.resolve();
  return exclusive(svc, identity, async () => {
    const h = unfinished(svc.state(identity));
    if (!h) return;
    if (h.step === "archived") {
      await complete(svc, identity);
      return;
    }
    svc.holds.add(h.old);
    try {
      if (await safeMoment(svc, identity, h.old, { resuming: true })) return svc.retryLater(identity);
      await complete(svc, identity);
    } finally {
      release(svc, h.old);
    }
  }).catch((error) => svc.warn(identity, `handover paused: ${message(error)}`));
}

/**
 * From a spawned new thread to done: move automations once the new thread runs (automations disable
 * themselves on a target that is not running yet), move what was held on the old thread, then archive it.
 * Archiving drops the old thread's queued rows, so nothing may be left there by then. After the spawn
 * nothing throws: the caller already has a new thread, so problems come back as text, and every return
 * that leaves the handover unfinished tries again later.
 */
async function complete(svc: MemoryService, identity: string): Promise<string | undefined> {
  let h = unfinished(svc.state(identity))!;
  const later = (text: string) => (svc.retryLater(identity), text);
  const warn = (text: string) => (svc.warn(identity, text), later(text));
  const sdk = svc.bb.sdk.threads;
  try {
    if (h.step === "spawned") {
      const started = await runnable(svc, h.new);
      if (started === "failed") return warn(`New conversation ${h.new} failed to start; \`bb assistants memory off\` makes ${h.old} the main chat again`);
      if (started === "late") return warn(`New conversation ${h.new} has not started; ${h.old} keeps its automations until it does`);
      const stuck = await repointAutomations(svc.bb, await targetingAutomationsOf(svc.bb, h.old), h.new);
      if (stuck.length > 0) return warn(`Old conversation kept, these automations still target it: ${stuck.join("; ")}`);
      // A child can get a message while only the root is held.
      const children = await childrenBusy(svc, h.old);
      if (children) return later(`${h.old} is archived once its children are done: ${children}`);
      const left = await moveHeld(svc, h.old, h.new);
      if (left.length > 0) return warn(`Messages on ${h.old} that cannot move: ${left.join(", ")}; it is archived once they are sent or removed`);
      await sdk.archive({ threadId: h.old });
      h = svc.update(identity, { handover: { ...h, step: "archived" } }).handover!;
    }
    svc.update(identity, { handover: { ...h, step: "done" } });
    svc.clearRetry(identity);
    return undefined;
  } catch (error) {
    return warn(`Handover to ${h.new} paused: ${message(error)}`);
  }
}

/** Recreate the old thread's plain rows on the new one; returns the ids of what is still on the old thread. */
async function moveHeld(svc: MemoryService, old: string, fresh: string): Promise<string[]> {
  const sdk = svc.bb.sdk.threads.queuedMessages;
  const rows = await sdk.list({ threadId: old });
  for (const [k, row] of rows.entries()) {
    if (!plain(rows, k)) continue;
    await sdk.create({
      threadId: fresh,
      input: row.content,
      ...(row.senderThreadId ? { senderThreadId: row.senderThreadId } : {}),
      model: row.model,
      reasoningLevel: row.reasoningLevel,
      permissionMode: row.permissionMode,
      serviceTier: row.serviceTier,
    } as Parameters<typeof sdk.create>[0]);
    await sdk.delete({ threadId: old, queuedMessageId: row.id });
  }
  // Listed again: a row that arrived while these moved must not be archived away.
  return (await sdk.list({ threadId: old })).map((row) => row.id);
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
