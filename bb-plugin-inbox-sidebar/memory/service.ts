// Memory for opted-in assistants: logs each main chat from bb's event log into its tree, keeps the
// summaries coming, and rotates the chat when its context fills. One instance per plugin load.
import fs from "node:fs";
import path from "node:path";
import type { spawn } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assistantConversationContext } from "../lib/assistant-conversation";
import { Busy, handover } from "./handover";
import { type EventRow, LOGGED_TYPES, recordsOf } from "./history";
import { dirName, identities, KEPT_WARNINGS, type MemoryState, readState, writeState } from "./state";
import { Summarizer } from "./summarize";
import { Chat, KINDS } from "./tree";

/** Realtime channel the Bots section re-reads memory warnings on. */
export const MEMORY_CHANNEL = "assistant-memory";
/** The view's sawtooth top: a session starts with at most this much memory. */
const VIEW_READY = 128_000;
const PAGE = 100;

export type MemorySettings = { rotateAtPercent: number; summaryModel: string; summaryPool: number; summaryTarget: number };

export const TIMING = {
  /** How long a rotation waits for summaries. */
  readinessMs: 5 * 60_000,
  /** How long a rotation someone asked for (composer, `bb assistants rotate`) waits for summaries. */
  readyCapMs: 60_000,
  /** How long a handover waits for the new thread to run before it moves automations. */
  runnableMs: 2 * 60_000,
  pollMs: 1000,
  /** A child that changed this recently may still be reporting to its parent (bb batches reports for 2 s). */
  quietMs: 5000,
  /** An automatic rotation a passing obstacle refused tries again after this. */
  retryMs: 30_000,
};
export type Timing = typeof TIMING;

type EventType = (typeof LOGGED_TYPES)[number] | "thread/compacted";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class MemoryService {
  /** Old threads mid-handover: their dispatches wait, so nothing starts there while the chat moves. */
  readonly holds = new Set<string>();
  /** The one running handover per identity. */
  readonly ops = new Map<string, Promise<unknown>>();
  readonly retries = new Map<string, NodeJS.Timeout>();
  readonly summarizer: Summarizer;
  settings: MemorySettings = { rotateAtPercent: 55, summaryModel: "haiku", summaryPool: 8, summaryTarget: 512 };
  disposed = false;
  private readonly states = new Map<string, MemoryState>();
  private readonly chats = new Map<string, Chat>();
  /** Appends per identity, one after another. */
  private readonly logging = new Map<string, Promise<void>>();
  /** Per identity and thread, the last event fully logged. */
  private readonly cursors = new Map<string, number>();
  /** Readiness waits by thread; a new turn there cancels its wait. */
  private readonly waits = new Map<string, AbortController>();
  private readonly usage = new Map<string, number>();
  private readonly importing = new Map<string, Promise<void>>();
  /** Per identity, archived threads whose last events are not all logged yet. */
  private readonly undrained = new Map<string, Set<string>>();

  constructor(
    readonly bb: BbPluginApi,
    readonly root: string,
    readonly timing: Timing = TIMING,
    spawnProcess?: typeof spawn,
  ) {
    this.summarizer = new Summarizer({ scratch: path.join(root, ".scratch"), log: (m) => bb.log.warn(m), spawn: spawnProcess });
  }

  dir(identity: string): string {
    return path.join(this.root, dirName(identity));
  }

  state(identity: string): MemoryState {
    let s = this.states.get(identity);
    if (!s) this.states.set(identity, (s = readState(this.dir(identity))));
    return s;
  }

  update(identity: string, patch: Partial<MemoryState>): MemoryState {
    const next = { ...this.state(identity), ...patch };
    writeState(this.dir(identity), next);
    this.states.set(identity, next);
    return next;
  }

  warn(identity: string, text: string): void {
    this.bb.log.warn(`memory ${identity}: ${text}`);
    const { warnings } = this.state(identity);
    // A retry that fails the same way again is not news.
    if (warnings.at(-1)?.text === text) return;
    this.update(identity, { warnings: [...warnings, { at: Date.now(), text }].slice(-KEPT_WARNINGS) });
    this.bb.realtime.publish(MEMORY_CHANNEL, { identity });
  }

  /** The one Chat of this identity in this process. */
  /** After `dispose`, nothing writes, reopens or spawns: the next plugin load owns the memory dirs. */
  private live(): void {
    if (this.disposed) throw new Error("memory service stopped");
  }

  chat(identity: string): Chat {
    this.live();
    let chat = this.chats.get(identity);
    if (!chat) {
      chat = Chat.open(this.dir(identity));
      chat.tune({ pool: this.settings.summaryPool, target: this.settings.summaryTarget });
      this.chats.set(identity, chat);
      this.summarizer.add(identity, chat);
    }
    return chat;
  }

  /** For reading: an assistant that never had memory gets an error, not an empty dir. */
  private existing(identity: string): Chat {
    if (!fs.existsSync(this.dir(identity))) throw new Error(`no memory for ${identity}`);
    return this.chat(identity);
  }

  isOn(identity: string): boolean {
    return this.state(identity).on;
  }

  configure(settings: MemorySettings): void {
    this.settings = settings;
    this.summarizer.model = settings.summaryModel;
    this.summarizer.pool = settings.summaryPool;
    for (const chat of this.chats.values()) chat.tune({ pool: settings.summaryPool, target: settings.summaryTarget });
    this.summarizer.pump();
  }

  /** Threads whose events go into this identity's log while it is on: the main chat and earlier ones still live. */
  private logged(identity: string): string[] {
    const s = this.state(identity);
    return s.on ? [...(s.main ? [s.main] : []), ...s.previous] : [];
  }

  private loggerOf(threadId: string): string | undefined {
    return [...this.states.keys()].find((identity) => this.logged(identity).includes(threadId));
  }

  async start(): Promise<void> {
    for (const identity of identities(this.root)) {
      // Archived or deleted while the plugin was down.
      await this.reconcile(identity);
      for (const threadId of this.logged(identity)) {
        await this.catchUp(identity, threadId).catch((e) => this.bb.log.warn(`memory ${identity}: ${message(e)}`));
      }
      // A rotation due when the plugin stopped has no idle left to wake it.
      void this.retry(identity);
    }
  }

  /** Let go of the tracked chats bb took away while nobody was looking. */
  private async reconcile(identity: string): Promise<void> {
    const { main, previous } = this.state(identity);
    for (const threadId of [...(main ? [main] : []), ...previous]) {
      const fate = await this.fate(threadId);
      if (fate) await this.gone(identity, threadId, fate);
    }
  }

  /** "archived" or "deleted" when bb took the thread away; null when it is there, or unknown for now. */
  private async fate(threadId: string): Promise<"archived" | "deleted" | null> {
    try {
      return (await this.bb.sdk.threads.get({ threadId })).archivedAt === null ? null : "archived";
    } catch (error) {
      return (error as { status?: unknown }).status === 404 ? "deleted" : null;
    }
  }

  /**
   * A main or earlier chat bb took away leaves the log: an archived one after its last events are in,
   * never before; a deleted one has none left. A main chat leaves `main` empty until `memory on` picks one.
   */
  private async gone(identity: string, threadId: string, fate: "archived" | "deleted"): Promise<void> {
    if (!this.state(identity).on) return;
    if (fate === "archived") {
      try {
        await this.catchUp(identity, threadId);
      } catch (error) {
        this.bb.log.warn(`memory ${identity}: ${threadId} stays tracked until its last events are logged: ${message(error)}`);
        this.undrained.set(identity, (this.undrained.get(identity) ?? new Set()).add(threadId));
        return this.retryLater(identity);
      }
    }
    const s = this.state(identity);
    if (s.main !== threadId) return void this.update(identity, { previous: s.previous.filter((id) => id !== threadId) });
    this.update(identity, { main: null });
    this.warn(identity, `Main chat ${threadId} was ${fate}; run bb assistants memory on <thread> to pick the new one.`);
  }

  async onGone(threadId: string, fate: "archived" | "deleted"): Promise<void> {
    for (const identity of this.states.keys()) {
      const { main, previous } = this.state(identity);
      if (main === threadId || previous.includes(threadId)) await this.gone(identity, threadId, fate);
    }
  }

  /** Try again to drain the archived threads whose drain failed. */
  private async drain(identity: string): Promise<void> {
    const threads = this.undrained.get(identity);
    // Taken out first: a drain that fails again puts its thread back.
    this.undrained.delete(identity);
    for (const threadId of threads ?? []) {
      // Unarchived since, it is a live chat again with nothing to drain; deleted, it has nothing left.
      const fate = await this.fate(threadId);
      if (fate) await this.gone(identity, threadId, fate);
    }
  }

  /** Log what `threadId` added since the last call. Serialized per identity; a failure keeps the cursor for the next wake-up. */
  catchUp(identity: string, threadId: string): Promise<void> {
    const next = (this.logging.get(identity) ?? Promise.resolve()).then(() =>
      this.logEvents(identity, threadId, [...LOGGED_TYPES, "thread/compacted"]),
    );
    this.logging.set(identity, next.catch(() => {}));
    return next;
  }

  private async logEvents(identity: string, threadId: string, types: EventType[], before?: () => Promise<void>): Promise<void> {
    const chat = this.chat(identity);
    if (chat.damaged) chat.reload();
    const stream = `thread:${threadId}`;
    // From the resume point itself: a crash may have cut its records short, and the tree skips the ones it has.
    const resumeAt = chat.resumeAt(stream);
    const cursor = `${identity} ${threadId}`;
    let after = this.cursors.get(cursor) ?? (resumeAt === undefined ? undefined : resumeAt - 1);
    for (;;) {
      const rows = (await this.bb.sdk.threads.events.list({
        threadId,
        types: types as [EventType, ...EventType[]],
        ...(after === undefined ? {} : { afterSeq: String(after) }),
        order: "asc",
        limit: String(PAGE),
      })) as unknown as EventRow[];
      for (const row of rows) {
        await before?.();
        this.live();
        if (row.type === "thread/compacted") {
          if (row.createdAt >= this.state(identity).since) this.warn(identity, `${threadId} compacted before rotation`);
        }
        else {
          // One source per event: the tree numbers its records, so a replay skips exactly the ones it has.
          const src = { stream, at: row.seq, n: 0 };
          for (const r of recordsOf(row)) chat.append(r.kind, r.text, r.date, src);
        }
        after = row.seq;
        this.cursors.set(cursor, row.seq);
      }
      this.summarizer.pump();
      if (rows.length < PAGE) return;
    }
  }

  /** Every message summarized and the view inside the sawtooth: the view a new session gets is whole. */
  ready(identity: string): boolean {
    const chat = this.chat(identity);
    chat.saw();
    return chat.unsummarized === 0 && chat.viewBytes().view <= VIEW_READY;
  }

  async readyWithin(identity: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    return this.ready(identity) || this.summarizer.waitUntil(this.chat(identity), () => this.ready(identity), ms, signal);
  }

  notReady(identity: string): string {
    const failed = this.chat(identity).failures;
    return failed > 0 ? `Memory summaries keep failing (${failed} failed); try again later` : "Memory summaries are still running";
  }

  /**
   * One timer per identity: an automatic rotation a passing obstacle refused tries again while the main
   * chat still sits idle after the same completed `turn`, with no lifecycle event to wake it.
   */
  private retryLater(identity: string, turn?: number): void {
    if (this.disposed || this.retries.has(identity)) return;
    const timer = setTimeout(() => {
      this.retries.delete(identity);
      void this.retry(identity, turn);
    }, this.timing.retryMs);
    this.retries.set(identity, timer);
  }

  private async retry(identity: string, turn?: number): Promise<void> {
    await this.drain(identity);
    const { on, main } = this.state(identity);
    if (!on || !main) return;
    try {
      // A turn running again ends at an idle, which tries again by itself.
      if ((await this.bb.sdk.threads.get({ threadId: main })).status !== "idle") return;
    } catch (error) {
      return this.bb.log.warn(`memory ${identity}: ${message(error)}`);
    }
    await this.maybeRotate(identity, main, turn);
  }

  onEvents(threadId: string): void {
    const identity = this.loggerOf(threadId);
    if (!identity) return;
    this.catchUp(identity, threadId)
      .then(() => this.drain(identity))
      .catch((e) => this.bb.log.warn(`memory ${identity}: ${message(e)}`));
  }

  async onIdle(threadId: string): Promise<void> {
    const identity = this.loggerOf(threadId);
    if (!identity) return;
    try {
      await this.catchUp(identity, threadId);
    } catch (error) {
      return this.bb.log.warn(`memory ${identity}: ${message(error)}`);
    }
    await this.drain(identity);
    await this.maybeRotate(identity, threadId);
  }

  onActive(threadId: string): void {
    this.waits.get(threadId)?.abort();
  }

  /**
   * At a completed turn's idle: rotate once the context passes the threshold and the view is ready.
   * With `turn`, only while that is still the last completed turn. Never throws.
   */
  async maybeRotate(identity: string, threadId: string, turn?: number): Promise<void> {
    const s = this.state(identity);
    if (!s.on || s.main !== threadId || this.waits.has(threadId)) return;
    // Registered before the first read, so a turn that starts during any of them cancels this attempt.
    const wait = new AbortController();
    this.waits.set(threadId, wait);
    const sdk = this.bb.sdk.threads;
    let last: EventRow | undefined;
    try {
      [last] = (await sdk.events.list({ threadId, types: ["turn/completed"], order: "desc", limit: "1" })) as unknown as EventRow[];
      if (last?.data?.status !== "completed" || (turn !== undefined && last.seq !== turn)) return;
      // A new session whose only request is its hidden bootstrap has nothing to carry on; rotating it would loop.
      const requests = (await sdk.events.list({ threadId, types: ["client/turn/requested"], order: "asc", limit: "2" })) as unknown as EventRow[];
      if (requests.length < 2 && requests.every((r) => recordsOf(r).length === 0)) return;
      const { usage } = await sdk.context({ threadId });
      const used = usage ? usage.usedTokens / usage.modelContextWindow : Number.NaN;
      if (!Number.isFinite(used)) return;
      this.usage.set(identity, used);
      if (used < this.settings.rotateAtPercent / 100) return;
      if (!(await this.readyWithin(identity, this.timing.readinessMs, wait.signal))) {
        if (wait.signal.aborted || this.disposed) return;
        this.warn(identity, "rotation skipped: summaries not ready");
        return this.retryLater(identity, last.seq);
      }
      if (wait.signal.aborted) return;
      await handover(this, { identity, oldThreadId: threadId });
    } catch (error) {
      if (this.disposed) return;
      if (!(error instanceof Busy)) return this.warn(identity, `rotation failed: ${message(error)}`);
      if (error.lasting) return this.warn(identity, `rotation waits: ${error.message}`);
      this.bb.log.info(`memory ${identity}: rotation waits: ${error.message}`);
      if (last && !wait.signal.aborted) this.retryLater(identity, last.seq);
    } finally {
      this.waits.delete(threadId);
    }
  }

  async on(threadId: string): Promise<string> {
    const { identity } = await assistantConversationContext(this.bb, threadId);
    const s = this.state(identity);
    if (this.importing.has(identity)) throw new Error("an import is running for this assistant; turn memory on when it is done");
    if (s.on && s.main && s.main !== threadId) {
      if (!(await this.fate(s.main))) throw new Error(`memory is already on, with main chat ${s.main}`);
      // The old main chat leaves as an earlier one does: drained first, kept in `previous` until that works.
      this.update(identity, { previous: [...s.previous, s.main] });
    }
    this.update(identity, { on: true, everOn: true, main: threadId, since: Date.now() });
    // An earlier chat archived or deleted while memory was off would hold rotation back.
    await this.reconcile(identity);
    await this.catchUp(identity, threadId);
    return identity;
  }

  /** Stops logging and rotating; the log, `recall` and `date` stay. */
  off(identity: string): void {
    const { main } = this.update(identity, { on: false });
    if (main) this.waits.get(main)?.abort();
  }

  clearWarnings(identity: string): void {
    this.update(identity, { warnings: [] });
    this.bb.realtime.publish(MEMORY_CHANNEL, { identity });
  }

  recall(identity: string, id: number, n: number): string {
    return this.existing(identity).zoom(id, n);
  }

  date(identity: string, id: number): string {
    return this.existing(identity).date(id);
  }

  status(identity: string): string {
    const s = this.state(identity);
    const chat = this.existing(identity);
    const { view, lines } = chat.viewBytes();
    const used = this.usage.get(identity);
    return [
      `memory: ${s.on ? "on" : "off"}`,
      `main: ${s.main ?? "-"}`,
      `messages: ${chat.T}`,
      `view: ${lines} lines, ${view} bytes`,
      `unsummarized: ${chat.unsummarized}, in flight: ${chat.inFlight}, failed: ${chat.failures}`,
      `last usage: ${used === undefined ? "-" : `${Math.round(used * 100)}%`}`,
      ...(s.import ? [`import: ${s.import.done}/${s.import.sources.length} sources${s.import.error ? `, stopped: ${s.import.error}` : ""}`] : []),
      ...(s.previous.length ? [`kept live: ${s.previous.join(", ")} (rotation waits until archived)`] : []),
      ...(s.warnings.length ? ["warnings:", ...s.warnings.map((w) => `  ${new Date(w.at).toISOString()} ${w.text}`)] : []),
    ].join("\n");
  }

  /** Latest warning per memory identity, for the Bots rows. */
  rows(): Array<{ identity: string; warning: string | null }> {
    for (const identity of identities(this.root)) this.state(identity);
    return [...this.states.entries()].map(([identity, s]) => ({ identity, warning: s.warnings.at(-1)?.text ?? null }));
  }

  /** Seed the log with past history before memory is ever on. Runs in the background; progress is in `status`. */
  startImport(identity: string, sources: string[]): void {
    if (this.state(identity).everOn) throw new Error("memory was on for this assistant already; import only runs before the first `memory on`");
    if (this.importing.has(identity)) throw new Error("an import is already running for this assistant");
    for (const source of sources) {
      if (!/^thr_\w+$/.test(source) && !(path.isAbsolute(source) && fs.existsSync(source))) {
        throw new Error(`${source}: want a thread id or an absolute path to a JSONL file on the bb server`);
      }
    }
    this.update(identity, { import: { sources, done: 0, error: null } });
    this.importing.set(identity, this.runImport(identity, sources).finally(() => this.importing.delete(identity)));
  }

  private async runImport(identity: string, sources: string[]): Promise<void> {
    const chat = this.chat(identity);
    const fail = (what: string) => new Error(this.disposed ? "stopped" : `${what}: ${chat.failures} summaries keep failing; run the import again to resume`);
    // Like a live chat whose summaries keep up: a summary's view stops at the first unsummarized line,
    // so racing ahead would cut its context (a tool result would lose its call).
    const keepUp = async () => {
      if (!(await this.summarizer.waitUntil(chat, () => chat.unsummarized === 0 && chat.backlog() <= chat.pool, Infinity))) throw fail("stopped");
    };
    let done = 0;
    try {
      for (const source of sources) {
        if (source.startsWith("thr_")) await this.logEvents(identity, source, [...LOGGED_TYPES], keepUp);
        else await this.importFile(chat, source, keepUp);
        this.update(identity, { import: { sources, done: ++done, error: null } });
      }
      if (!(await this.summarizer.waitUntil(chat, () => chat.idle(), Infinity))) throw fail("imported, but not all summarized");
    } catch (error) {
      this.update(identity, { import: { sources, done, error: message(error) } });
    }
  }

  /** Lines of `{kind, text, date}`; each record carries its line, so a second run skips what the first logged. */
  private async importFile(chat: Chat, file: string, before: () => Promise<void>): Promise<void> {
    const stream = `import:${file}`;
    // A run a failed write stopped is read back first, so running the import again resumes it.
    if (chat.damaged) chat.reload();
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (let n = chat.resumeAt(stream) ?? 0; n < lines.length; n++) {
      const { kind, text, date } = JSON.parse(lines[n]);
      if (!KINDS.includes(kind) || typeof text !== "string" || typeof date !== "string") {
        throw new Error(`${file}:${n + 1}: want {kind, text, date} with kind in ${KINDS.join("|")}`);
      }
      await before();
      this.live();
      chat.append(kind, text, date, { stream, at: n, n: 0 });
      this.summarizer.pump();
    }
  }

  /** Lets logging, handovers and imports in flight stop at their next check, then closes the chats. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.summarizer.dispose();
    for (const wait of this.waits.values()) wait.abort();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await Promise.allSettled([...this.logging.values(), ...this.ops.values(), ...this.importing.values()]);
    for (const chat of this.chats.values()) chat.close();
    this.chats.clear();
  }

}

