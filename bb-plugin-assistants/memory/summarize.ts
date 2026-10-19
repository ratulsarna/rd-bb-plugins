// Summary calls for every memory chat, through a CLI on the bb server: `claude -p` on its Claude
// login, or `pi -p` with any model pi knows. One pool across all chats, so a long import cannot
// crowd the account or starve a live chat.
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { SUMMARY_PROMPT } from "./prompt";
import { bytes, type Chat, cleanLine, type Job, LINE, tooLong } from "./tree";

const ATTEMPTS = 5;
export const CALL_TIMEOUT_MS = 3 * 60_000;
/** Failed calls in a row that stop all summaries for `BRAKE_MS`: a spent account fails every call. */
const BRAKE_AFTER = 5;
export const BRAKE_MS = 10 * 60_000;

const without = (env: NodeJS.ProcessEnv, drop: (key: string) => boolean): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !drop(k)));

/**
 * How each CLI is asked for one summary: one reply on stdout, no tools, no session, and nothing
 * loaded from disk. Neither gets bb thread context to act on.
 */
const RUNNERS = {
  claude: {
    args: (model: string) => ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--model", model, "--system-prompt", SUMMARY_PROMPT, "--output-format", "text"],
    // The subscription login, never an API key.
    env: (env: NodeJS.ProcessEnv) => without(env, (k) => k.startsWith("ANTHROPIC_") || k.startsWith("BB_") || k === "CLAUDE_CODE_OAUTH_TOKEN"),
  },
  pi: {
    args: (model: string) => ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--thinking", "off", "--model", model, "--system-prompt", SUMMARY_PROMPT],
    env: (env: NodeJS.ProcessEnv) => without(env, (k) => k.startsWith("BB_")),
  },
};
export type SummaryRunner = keyof typeof RUNNERS;
export const SUMMARY_RUNNERS = Object.keys(RUNNERS) as SummaryRunner[];

export class Summarizer {
  private readonly chats: Array<{ identity: string; chat: Chat }> = [];
  private turn = 0;
  private running = 0;
  private readonly procs = new Set<ChildProcess>();
  private readonly changed = new EventEmitter();
  private disposed = false;
  private failedInRow = 0;
  private brakeUntil = 0;
  private brakeTimer: NodeJS.Timeout | undefined;
  runner: SummaryRunner = "claude";
  model = "haiku";
  pool = 8;
  paused = false;

  constructor(
    private readonly opts: {
      /** An empty dir the calls run in, so no project files or settings load. */
      scratch: string;
      log: (message: string) => void;
      /** Shown on every memory chat when the brake stops summaries. */
      warn: (message: string) => void;
      spawn?: typeof nodeSpawn;
      timeoutMs?: number;
      brakeMs?: number;
    },
  ) {
    this.changed.setMaxListeners(0);
  }

  add(identity: string, chat: Chat): void {
    this.chats.push({ identity, chat });
    // A failed write wakes the waits on this chat, which then end with it.
    void chat.broken.then(() => this.changed.emit("progress"));
  }

  /** Stop giving `chat` work; calls already running for it finish and are dropped. */
  remove(chat: Chat): void {
    const k = this.chats.findIndex((member) => member.chat === chat);
    if (k >= 0) this.chats.splice(k, 1);
  }

  /** Why no summary call starts now, if none does. */
  blocked(): string | undefined {
    if (this.paused) return "Memory summaries are paused";
    const left = Math.ceil((this.brakeUntil - Date.now()) / 60_000);
    if (left > 0) return `Memory summaries are stopped for ${left} more min after ${BRAKE_AFTER} failed calls in a row`;
    return undefined;
  }

  /** Start again, failed claims too: no new message may come to retry them. */
  resume(): void {
    for (const { chat } of this.chats) chat.retryFailed();
    this.pump();
    this.changed.emit("progress");
  }

  /** Start jobs while the pool has room, taking from each chat in turn. */
  pump(): void {
    if (this.blocked()) return;
    for (let empty = 0; !this.disposed && this.running < this.pool && empty < this.chats.length; ) {
      const member = this.chats[this.turn++ % this.chats.length];
      const job = member.chat.take();
      if (!job) {
        empty++;
        continue;
      }
      empty = 0;
      void this.run(member, job);
    }
  }

  private async run({ identity, chat }: { identity: string; chat: Chat }, job: Job): Promise<void> {
    this.running++;
    let line: string | undefined;
    let why = "empty reply";
    try {
      line = await this.summarize(job.prompt);
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
      if (!this.disposed) this.opts.log(`memory ${identity}: summary failed: ${why}`);
    }
    this.running--;
    // A plugin reload in between: the chat belongs to the next instance now.
    if (this.disposed) return;
    if (line === undefined) {
      chat.fail(job.ref);
      if (++this.failedInRow >= BRAKE_AFTER) this.brake(why);
    } else {
      chat.done(job.ref, line);
      this.failedInRow = 0;
    }
    // A damaged chat dropped the line, and its slot still goes back to the pool.
    if (!chat.damage) chat.flush().catch((error) => this.opts.log(`memory ${identity}: summary not saved: ${error instanceof Error ? error.message : String(error)}`));
    this.pump();
    this.changed.emit("progress");
  }

  /** Calls still in flight may fail too; they do not stop it again. */
  private brake(why: string): void {
    this.failedInRow = 0;
    if (this.brakeUntil > Date.now()) return;
    const ms = this.opts.brakeMs ?? BRAKE_MS;
    this.brakeUntil = Date.now() + ms;
    this.opts.warn(`Memory summaries stopped for ${Math.ceil(ms / 60_000)} min after ${BRAKE_AFTER} failed calls in a row. Last error: ${why.slice(0, 200)}`);
    this.brakeTimer = setTimeout(() => {
      this.brakeUntil = 0;
      this.resume();
    }, ms);
  }

  /** The first line that fits, else the shortest of `ATTEMPTS` (fewer once summaries stop); undefined for an empty reply. */
  private async summarize(input: string): Promise<string | undefined> {
    let best: string | undefined;
    let last: string | undefined;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      // Paused or braked since the last try: keep the shortest line rather than start another call.
      if (attempt > 0 && this.blocked()) break;
      // Each call is fresh, so a retry carries the input again with the cut the last reply overran.
      last = cleanLine(await this.call(last === undefined ? input : `${input}\n\n${tooLong(last)}`));
      if (!last) return undefined;
      if (best === undefined || bytes(last) < bytes(best)) best = last;
      if (bytes(last) <= LINE) return last;
    }
    return best;
  }

  private call(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new Error("memory service stopped"));
      fs.mkdirSync(this.opts.scratch, { recursive: true });
      const runner = this.runner;
      const { args, env } = RUNNERS[runner];
      const child = (this.opts.spawn ?? nodeSpawn)(runner, args(this.model), { cwd: this.opts.scratch, env: env(process.env), stdio: ["pipe", "pipe", "pipe"] });
      this.procs.add(child);
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.opts.timeoutMs ?? CALL_TIMEOUT_MS);
      const settle = (error?: Error) => {
        clearTimeout(timer);
        this.procs.delete(child);
        if (error) reject(error);
        else resolve(out);
      };
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (err += d));
      child.once("error", settle);
      child.once("close", (code, signal) => {
        if (code === 0) return settle();
        settle(new Error(timedOut ? "timed out" : `${runner} exited ${code ?? signal}: ${err.trim().slice(0, 300)}`));
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
    });
  }

  /**
   * Wait until `done()`, at most `ms`, while summaries for any chat finish. Another chat may hold every
   * slot, so this chat's runnable work waits for progress anywhere. A failed call waits for the next
   * message, so when this chat has nothing else to run it gets that retry here, at most 3 rounds.
   * False on timeout, abort, dispose, or calls that keep failing; throws why when a write damages `chat`.
   */
  async waitUntil(chat: Chat, done: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(Math.min(ms, 2 ** 31 - 1));
    const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
    for (let rounds = 0; !done(); ) {
      if (chat.damage) throw chat.damage;
      if (this.disposed || stop.aborted) return false;
      if (chat.inFlight > 0 || chat.canTake()) {
        this.pump();
        await once(this.changed, "progress", { signal: stop }).catch(() => undefined);
      } else if (chat.failures === 0 || rounds++ >= 3) return false;
      else {
        chat.retryFailed();
        this.pump();
      }
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.brakeTimer);
    for (const child of this.procs) child.kill("SIGKILL");
    this.changed.emit("progress");
  }
}
