// Memory for opted-in assistants: logs each main chat from bb's event log into its tree, keeps the
// summaries coming, and gives the chat its memory at every session start. The chat never moves: Claude
// Code compacts it, and the SessionStart hook hands it the view again. One instance per plugin load.
import fs from "node:fs";
import path from "node:path";
import type { spawn } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assistantConversationContext } from "../lib/assistant-conversation";
import { createIdentityResolver, type ResolvedIdentity } from "../lib/assistant-identity";
import { setHook } from "./hook";
import { snapshot } from "./prompt";
import { type EventRow, LOGGED_TYPES, recordsOf, spokenDate } from "./history";
import { dirName, identities, KEPT_WARNINGS, type MemoryState, readState, writeState } from "./state";
import { Summarizer, type SummaryRunner } from "./summarize";
import { Chat, KINDS } from "./tree";

/** Realtime channel the Bots section re-reads memory warnings on. */
export const MEMORY_CHANNEL = "assistant-memory";
/** The view's sawtooth top: a session starts with at most this much memory. */
const VIEW_READY = 128_000;
const PAGE = 100;

export type MemorySettings = {
  summaryRunner: string;
  summaryModel: string;
  summaryPool: number;
  summaryTarget: number;
  timeZone: string;
  summariesPaused: boolean;
};

export const TIMING = {
  /** An archived chat whose last events could not be logged tries again after this. */
  retryMs: 30_000,
};
export type Timing = typeof TIMING;

type EventType = (typeof LOGGED_TYPES)[number];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class MemoryService {
  readonly retries = new Map<string, NodeJS.Timeout>();
  readonly summarizer: Summarizer;
  /** Which assistant a thread's environment belongs to, as the rest of the plugin decides it. */
  readonly identityOf: (environmentId: string) => Promise<ResolvedIdentity>;
  settings: MemorySettings = { summaryRunner: "claude", summaryModel: "haiku", summaryPool: 8, summaryTarget: 512, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, summariesPaused: false };
  disposed = false;
  private readonly states = new Map<string, MemoryState>();
  private readonly chats = new Map<string, Chat>();
  /** Appends per identity, one after another. */
  private readonly logging = new Map<string, Promise<void>>();
  /** Per identity and thread, the last event fully logged. */
  private readonly cursors = new Map<string, number>();
  private readonly importing = new Map<string, Promise<void>>();
  /** Per identity, archived threads whose last events are not all logged yet. */
  private readonly undrained = new Map<string, Set<string>>();

  constructor(
    readonly bb: BbPluginApi,
    readonly root: string,
    readonly timing: Timing = TIMING,
    spawnProcess?: typeof spawn,
  ) {
    this.identityOf = createIdentityResolver(bb);
    this.summarizer = new Summarizer({
      scratch: path.join(root, ".scratch"),
      log: (m) => bb.log.warn(m),
      warn: (m) => {
        for (const identity of this.chats.keys()) this.warn(identity, m);
      },
      unwarn: (m) => {
        for (const identity of this.chats.keys()) this.unwarn(identity, m);
      },
      spawn: spawnProcess,
    });
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

  /** Never throws: callers run detached, and a full disk is often what they warn about. */
  warn(identity: string, text: string): void {
    this.bb.log.warn(`memory ${identity}: ${text}`);
    const s = this.state(identity);
    // A retry that fails the same way again is not news.
    if (s.warnings.at(-1)?.text === text) return;
    this.updateBestEffort(identity, { warnings: [...s.warnings, { at: Date.now(), text }].slice(-KEPT_WARNINGS) });
    this.bb.realtime.publish(MEMORY_CHANNEL, { identity });
  }

  unwarn(identity: string, text: string): void {
    const s = this.state(identity);
    const warnings = s.warnings.filter((w) => w.text !== text);
    if (warnings.length === s.warnings.length) return;
    this.updateBestEffort(identity, { warnings });
    this.bb.realtime.publish(MEMORY_CHANNEL, { identity });
  }

  /** `update` that never throws: applied in memory even when the disk refuses it; the next write that lands saves it. */
  updateBestEffort(identity: string, patch: Partial<MemoryState>): void {
    try {
      this.update(identity, patch);
    } catch (error) {
      this.states.set(identity, { ...this.state(identity), ...patch });
      this.bb.log.warn(`memory ${identity}: could not save ${Object.keys(patch).join(", ")}: ${message(error)}`);
    }
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
      chat.tune({ pool: this.settings.summaryPool, target: this.settings.summaryTarget, zone: this.settings.timeZone });
      this.chats.set(identity, chat);
      this.summarizer.add(identity, chat);
      // One warning per failed write.
      void chat.broken.then((error) => {
        if (!this.disposed) this.warn(identity, `${error.message}; memory reads the disk back at the next turn`);
      });
    }
    return chat;
  }

  /** The chat to write to. A damaged one is closed and a fresh one opened from the disk. */
  private async writer(identity: string): Promise<Chat> {
    const chat = this.chat(identity);
    if (!chat.damage) return chat;
    // Writers take turns (live logging per assistant, an import only before memory is first on), so no
    // other one is replacing it meanwhile. Readers keep the old one until it is closed.
    await chat.close();
    this.summarizer.remove(chat);
    this.chats.delete(identity);
    return this.chat(identity);
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
    // bb's select setting stores only its options.
    this.summarizer.runner = settings.summaryRunner as SummaryRunner;
    this.summarizer.model = settings.summaryModel;
    this.summarizer.pool = settings.summaryPool;
    this.summarizer.paused = settings.summariesPaused;
    for (const chat of this.chats.values()) chat.tune({ pool: settings.summaryPool, target: settings.summaryTarget, zone: settings.timeZone });
    // Unpaused, or a new runner or model: what failed before gets another try now.
    this.summarizer.resume();
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
      // Each load brings this version's script, and puts back a hook lost meanwhile.
      const { on, main } = this.state(identity);
      if (on && main && !this.disposed) {
        await this.homeOf(main)
          .then((home) => setHook(this.bb, home, true, main))
          .catch((e) => this.warn(identity, `memory hook not installed: ${message(e)}; run bb assistants memory on ${main}`));
      }
    }
  }

  /** The machine and home `threadId` runs in. */
  private async homeOf(threadId: string): Promise<{ hostId: string; home: string }> {
    const { environmentId } = await this.bb.sdk.threads.get({ threadId });
    const env = environmentId ? await this.bb.sdk.environments.get({ environmentId }) : null;
    if (!env?.path) throw new Error(`${threadId} runs in no home`);
    return { hostId: env.hostId, home: env.path };
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
    // Startup, retries and events reach here detached from `dispose`; the next plugin load owns memory.json.
    if (this.disposed) return;
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
    // Live logging replays from its cursor, which moves only once a page is on disk.
    const next = (this.logging.get(identity) ?? Promise.resolve()).then(async () =>
      this.logEvents(await this.writer(identity), identity, threadId, [...LOGGED_TYPES]),
    );
    this.logging.set(identity, next.catch(() => {}));
    return next;
  }

  private async logEvents(chat: Chat, identity: string, threadId: string, types: EventType[], before?: () => Promise<void>): Promise<void> {
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
        // One source per event: the tree numbers its records, so a replay skips exactly the ones it has.
        const src = { stream, at: row.seq, n: 0 };
        for (const r of recordsOf(row)) chat.append(r.kind, r.text, r.date, src);
      }
      // The cursor moves once the page is on disk: after a failed write the page is fetched again.
      await chat.flush();
      if (rows.length > 0) {
        after = rows.at(-1)!.seq;
        this.cursors.set(cursor, after);
      }
      this.summarizer.pump();
      if (rows.length < PAGE) return;
    }
  }

  notReady(identity: string): string {
    const blocked = this.summarizer.blocked();
    if (blocked) return blocked;
    const failed = this.chat(identity).failures;
    return failed > 0 ? `Memory summaries keep failing (${failed} failed); try again later` : "Memory summaries are still running";
  }

  /** One timer per identity: archived chats whose drain failed try again, with no event to wake them. */
  private retryLater(identity: string): void {
    if (this.disposed || this.retries.has(identity)) return;
    const timer = setTimeout(() => {
      this.retries.delete(identity);
      void this.drain(identity);
    }, this.timing.retryMs);
    this.retries.set(identity, timer);
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
  }

  /** Binds `threadId` as the main chat and installs the hook that gives it its memory. Running it again repairs the hook. */
  async on(threadId: string): Promise<string> {
    const { identity, env, thread } = await assistantConversationContext(this.bb, threadId);
    // The view reaches a new session only through the Claude Code hook.
    if (thread.providerId !== "claude-code") throw new Error(`memory needs a Claude Code thread; ${threadId} runs ${thread.providerId}`);
    const s = this.state(identity);
    if (this.importing.has(identity)) throw new Error("an import is running for this assistant; turn memory on when it is done");
    if (s.on && s.main && s.main !== threadId && !(await this.fate(s.main))) throw new Error(`memory is already on, with main chat ${s.main}`);
    await setHook(this.bb, { hostId: env.hostId, home: env.path! }, true, threadId);
    if (s.on && s.main && s.main !== threadId) {
      // The old main chat leaves as an earlier one does: drained first, kept in `previous` until that works.
      this.update(identity, { previous: [...s.previous, s.main] });
    }
    this.update(identity, { on: true, everOn: true, main: threadId });
    // Earlier chats archived or deleted while memory was off are let go now.
    await this.reconcile(identity);
    await this.catchUp(identity, threadId);
    return identity;
  }

  /** Stops logging, then removes the hook from the home `threadId` runs in; the log, `recall` and `date` stay. */
  async off(identity: string, threadId: string): Promise<void> {
    this.update(identity, { on: false });
    try {
      await setHook(this.bb, await this.homeOf(threadId), false);
    } catch (error) {
      throw new Error(`memory is off for ${identity}, but its hook could not be removed: ${message(error)}`);
    }
  }

  clearWarnings(identity: string): void {
    this.updateBestEffort(identity, { warnings: [] });
    this.bb.realtime.publish(MEMORY_CHANNEL, { identity });
  }

  recall(identity: string, id: number, n: number): string {
    return this.existing(identity).zoom(id, n);
  }

  /** The memory snapshot `threadId` reads at a session start, after logging what it has already said. */
  async snapshot(identity: string, threadId: string): Promise<string> {
    await this.catchUp(identity, threadId);
    const chat = this.existing(identity);
    chat.saw();
    // Merges wait on summaries, so a stalled summarizer leaves a view too big to read in one go.
    const { view } = chat.viewBytes();
    if (view > VIEW_READY) throw new Error(`memory view is ${view} bytes, over ${VIEW_READY}: ${this.notReady(identity)}`);
    return snapshot(chat.viewLines(), { threadId, messages: chat.T, at: new Date().toISOString() });
  }

  date(identity: string, id: number): string {
    return spokenDate(this.existing(identity).date(id));
  }

  status(identity: string): string {
    const s = this.state(identity);
    const chat = this.existing(identity);
    const { view, lines } = chat.viewBytes();
    const blocked = this.summarizer.blocked();
    return [
      `memory: ${s.on ? "on" : "off"}`,
      `main: ${s.main ?? "-"}`,
      `messages: ${chat.T}`,
      `view: ${lines} lines, ${view} bytes`,
      `unsummarized: ${chat.unsummarized}, in flight: ${chat.inFlight}, failed: ${chat.failures}`,
      ...(chat.redoing ? [`rebuilding: ${chat.redoing} lines left`] : []),
      `summaries: ${this.summarizer.runner} ${this.summarizer.model}, ${this.summarizer.pool} at once`,
      ...(blocked ? [blocked] : []),
      ...(s.import ? [`import: ${s.import.done}/${s.import.sources.length} sources${s.import.error ? `, stopped: ${s.import.error}` : ""}`] : []),
      ...(s.previous.length ? [`earlier chats still draining: ${s.previous.join(", ")}`] : []),
      ...(s.warnings.length ? ["warnings:", ...s.warnings.map((w) => `  ${new Date(w.at).toISOString()} ${w.text}`)] : []),
    ].join("\n");
  }

  /** Summarize again every line from message `from` on; summaries must be paused while it starts. */
  async rebuild(identity: string, from: number): Promise<string> {
    const chat = await this.writer(identity);
    const lines = await chat.rebuild(from);
    this.summarizer.pump();
    return `Rebuilding ${lines} lines from message ${from}; old lines stay until their new ones land. Progress: bb assistants memory status`;
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
    let done = 0;
    try {
      // Read back once, before the run: the run writes to this one Chat, and a failed write ends it.
      // Running the import again resumes from the last write that landed.
      const chat = await this.writer(identity);
      const fail = (what: string) => new Error(this.disposed ? "stopped" : `${what}: ${chat.failures} summaries keep failing; run the import again to resume`);
      // Like a live chat whose summaries keep up: a summary's view stops at the first unsummarized line,
      // so racing ahead would cut its context (a tool result would lose its call).
      const keepUp = async () => {
        if (!(await this.summarizer.waitUntil(chat, () => chat.unsummarized === 0 && chat.backlog() <= chat.pool, Infinity))) throw fail("stopped");
      };
      for (const source of sources) {
        if (source.startsWith("thr_")) await this.logEvents(chat, identity, source, [...LOGGED_TYPES], keepUp);
        else await this.importFile(chat, source, keepUp);
        this.update(identity, { import: { sources, done: ++done, error: null } });
      }
      if (!(await this.summarizer.waitUntil(chat, () => chat.idle(), Infinity))) throw fail("imported, but not all summarized");
      // The last summary is settled but may not be on disk yet; its failed write is this import's error.
      await chat.flush();
    } catch (error) {
      // Best effort: on a full disk the state write that records why fails too.
      try {
        this.update(identity, { import: { sources, done, error: message(error) } });
      } catch (cause) {
        this.bb.log.warn(`memory ${identity}: import stopped: ${message(error)}; could not save that: ${message(cause)}`);
      }
    }
  }

  /** Lines of `{kind, text, date}`; each record carries its line, so a second run skips what the first logged. */
  private async importFile(chat: Chat, file: string, before: () => Promise<void>): Promise<void> {
    const stream = `import:${file}`;
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
    await chat.flush();
  }

  /** Lets logging and imports in flight stop at their next check, then closes the chats. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.summarizer.dispose();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await Promise.allSettled([...this.logging.values(), ...this.importing.values()]);
    await Promise.allSettled([...this.chats.values()].map((chat) => chat.close()));
    this.chats.clear();
  }

}

