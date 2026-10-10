// Memory for opted-in assistants: logs each main chat from bb's event log into its tree, keeps the
// summaries coming, and rotates the chat when its context fills. One instance per plugin load.
import fs from "node:fs";
import path from "node:path";
import type { spawn } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assistantConversationContext } from "../lib/assistant-conversation";
import { Busy, handover, resume } from "./handover";
import { type EventRow, LOGGED_TYPES, recordsOf } from "./history";
import { dirName, identities, KEPT_WARNINGS, type MemoryState, readState, unfinished, writeState } from "./state";
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
  /** How long a handover waits for the new thread to run before it moves automations. */
  runnableMs: 2 * 60_000,
  pollMs: 1000,
  /** A child that changed this recently may still be reporting to its parent (bb batches reports for 2 s). */
  quietMs: 5000,
  /** A resume a busy moment refused tries again after this. */
  retryMs: 30_000,
};
export type Timing = typeof TIMING;

type EventType = (typeof LOGGED_TYPES)[number] | "thread/compacted";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class MemoryService {
  /** Old threads mid-handover: their dispatches wait, so nothing starts there while the chat moves. */
  readonly holds = new Set<string>();
  /** The one running handover or resume per identity. */
  readonly ops = new Map<string, Promise<unknown>>();
  readonly retries = new Map<string, NodeJS.Timeout>();
  readonly summarizer: Summarizer;
  settings: MemorySettings = { rotateAtPercent: 55, summaryModel: "haiku", summaryPool: 8, summaryTarget: 512 };
  disposed = false;
  private readonly states = new Map<string, MemoryState>();
  private readonly chats = new Map<string, Chat>();
  /** Appends per identity, one after another. */
  private readonly logging = new Map<string, Promise<void>>();
  /** Per thread, the last event fully logged. */
  private readonly cursors = new Map<string, number>();
  /** Readiness waits by thread; a new turn there cancels its wait. */
  private readonly waits = new Map<string, AbortController>();
  private readonly usage = new Map<string, number>();
  private readonly importing = new Set<string>();

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
    this.update(identity, { warnings: [...this.state(identity).warnings, { at: Date.now(), text }].slice(-KEPT_WARNINGS) });
    this.bb.realtime.publish(MEMORY_CHANNEL, { identity });
  }

  /** The one Chat of this identity in this process. */
  chat(identity: string): Chat {
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

  /** Threads whose events go into this identity's log: the main chat while on, and an old one mid-handover. */
  private logged(identity: string): string[] {
    const s = this.state(identity);
    return [...(s.on && s.main ? [s.main] : []), ...(unfinished(s) ? [unfinished(s)!.old] : [])];
  }

  private loggerOf(threadId: string): string | undefined {
    return [...this.states.keys()].find((identity) => this.logged(identity).includes(threadId));
  }

  async start(): Promise<void> {
    for (const identity of identities(this.root)) {
      for (const threadId of this.logged(identity)) await this.catchUp(identity, threadId).catch((e) => this.bb.log.warn(`memory ${identity}: ${message(e)}`));
      if (unfinished(this.state(identity))) void resume(this, identity);
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
    let after = this.cursors.get(threadId) ?? (resumeAt === undefined ? undefined : resumeAt - 1);
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
        if (row.type === "thread/compacted") this.warn(identity, `${threadId} compacted before rotation`);
        else {
          // One source per event: the tree numbers its records, so a replay skips exactly the ones it has.
          const src = { stream, at: row.seq, n: 0 };
          for (const r of recordsOf(row)) chat.append(r.kind, r.text, r.date, src);
        }
        after = row.seq;
        this.cursors.set(threadId, row.seq);
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

  onEvents(threadId: string): void {
    const identity = this.loggerOf(threadId);
    if (identity) this.catchUp(identity, threadId).catch((e) => this.bb.log.warn(`memory ${identity}: ${message(e)}`));
  }

  async onIdle(threadId: string): Promise<void> {
    for (const identity of this.states.keys()) {
      const h = unfinished(this.state(identity));
      if (h && (h.old === threadId || h.new === threadId)) void resume(this, identity);
    }
    const identity = this.loggerOf(threadId);
    if (!identity) return;
    try {
      await this.catchUp(identity, threadId);
    } catch (error) {
      return this.bb.log.warn(`memory ${identity}: ${message(error)}`);
    }
    await this.maybeRotate(identity, threadId);
  }

  onActive(threadId: string): void {
    this.waits.get(threadId)?.abort();
    for (const identity of this.states.keys()) {
      if (unfinished(this.state(identity))?.new === threadId) void resume(this, identity);
    }
  }

  /** At a completed turn's idle: rotate once the context passes the threshold and the view is ready. */
  async maybeRotate(identity: string, threadId: string): Promise<void> {
    const s = this.state(identity);
    if (!s.on || s.main !== threadId || unfinished(s) || this.waits.has(threadId)) return;
    try {
      const [last] = (await this.bb.sdk.threads.events.list({ threadId, types: ["turn/completed"], order: "desc", limit: "1" })) as unknown as EventRow[];
      if (last?.data?.status !== "completed") return;
      const { usage } = await this.bb.sdk.threads.context({ threadId });
      const used = usage ? usage.usedTokens / usage.modelContextWindow : Number.NaN;
      if (!Number.isFinite(used)) return;
      this.usage.set(identity, used);
      if (used < this.settings.rotateAtPercent / 100) return;
      if (!this.ready(identity)) {
        const wait = new AbortController();
        this.waits.set(threadId, wait);
        try {
          const chat = this.chat(identity);
          if (!(await this.summarizer.waitUntil(chat, () => this.ready(identity), this.timing.readinessMs, wait.signal))) {
            if (!wait.signal.aborted && !this.disposed) this.warn(identity, "rotation skipped: summaries not ready");
            return;
          }
        } finally {
          this.waits.delete(threadId);
        }
      }
      await handover(this, { identity, oldThreadId: threadId });
    } catch (error) {
      if (error instanceof Busy) this.bb.log.info(`memory ${identity}: rotation waits: ${error.message}`);
      else this.warn(identity, `rotation failed: ${message(error)}`);
    }
  }

  async on(threadId: string): Promise<string> {
    const { identity } = await assistantConversationContext(this.bb, threadId);
    const s = this.state(identity);
    if (this.importing.has(identity)) throw new Error("an import is running for this assistant; turn memory on when it is done");
    if (s.on && s.main !== threadId) throw new Error(`memory is already on, with main chat ${s.main}`);
    this.update(identity, { on: true, everOn: true, main: threadId });
    await this.catchUp(identity, threadId);
    return identity;
  }

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
    const h = unfinished(s);
    return [
      `memory: ${s.on ? "on" : "off"}`,
      `main: ${s.main ?? "-"}`,
      `messages: ${chat.T}`,
      `view: ${lines} lines, ${view} bytes`,
      `unsummarized: ${chat.unsummarized}, in flight: ${chat.inFlight}, failed: ${chat.failures}`,
      `last usage: ${used === undefined ? "-" : `${Math.round(used * 100)}%`}`,
      ...(s.import ? [`import: ${s.import.done}/${s.import.sources.length} sources${s.import.error ? `, stopped: ${s.import.error}` : ""}`] : []),
      ...(h ? [`handover: ${h.old} -> ${h.new} (${h.step})`] : []),
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
    this.importing.add(identity);
    this.update(identity, { import: { sources, done: 0, error: null } });
    void this.runImport(identity, sources).finally(() => this.importing.delete(identity));
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
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (let n = chat.resumeAt(stream) ?? 0; n < lines.length; n++) {
      const { kind, text, date } = JSON.parse(lines[n]);
      if (!KINDS.includes(kind) || typeof text !== "string" || typeof date !== "string") {
        throw new Error(`${file}:${n + 1}: want {kind, text, date} with kind in ${KINDS.join("|")}`);
      }
      await before();
      chat.append(kind, text, date, { stream, at: n, n: 0 });
      this.summarizer.pump();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.summarizer.dispose();
    for (const wait of this.waits.values()) wait.abort();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    for (const chat of this.chats.values()) chat.close();
    this.chats.clear();
  }
}

