// Summary calls for every memory chat, through `claude -p` on the bb server's Claude login.
// One pool across all chats, so a long import cannot crowd the subscription or starve a live chat.
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { SUMMARY_PROMPT } from "./prompt";
import { bytes, type Chat, cleanLine, type Job, LINE, tooLong } from "./tree";

const ATTEMPTS = 5;
export const CALL_TIMEOUT_MS = 3 * 60_000;

/** The subscription login, never an API key, and no bb thread context to act on. */
export function summaryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith("ANTHROPIC_") && !k.startsWith("BB_") && k !== "CLAUDE_CODE_OAUTH_TOKEN"),
  );
}

export class Summarizer {
  private readonly chats: Array<{ identity: string; chat: Chat }> = [];
  private turn = 0;
  private running = 0;
  private readonly procs = new Set<ChildProcess>();
  private readonly changed = new EventEmitter();
  private disposed = false;
  model = "haiku";
  pool = 8;

  constructor(
    private readonly opts: {
      /** An empty dir the calls run in, so no project files or settings load. */
      scratch: string;
      log: (message: string) => void;
      spawn?: typeof nodeSpawn;
      timeoutMs?: number;
    },
  ) {
    this.changed.setMaxListeners(0);
  }

  add(identity: string, chat: Chat): void {
    this.chats.push({ identity, chat });
  }

  /** Start jobs while the pool has room, taking from each chat in turn. */
  pump(): void {
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
    try {
      line = await this.summarize(job.prompt);
    } catch (error) {
      if (!this.disposed) this.opts.log(`memory ${identity}: summary failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.running--;
    // A plugin reload in between: the chat belongs to the next instance now.
    if (this.disposed) return;
    try {
      if (line === undefined) chat.fail(job.ref);
      else chat.done(job.ref, line);
    } catch (error) {
      // The tree could not take the line, as when the chat is damaged: tried again like a failed call.
      chat.fail(job.ref);
      this.opts.log(`memory ${identity}: summary not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.pump();
    this.changed.emit("progress");
  }

  /** The first line that fits, else the shortest of `ATTEMPTS`; undefined for an empty reply. */
  private async summarize(input: string): Promise<string | undefined> {
    let best: string | undefined;
    let last: string | undefined;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
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
      const args = ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--model", this.model, "--system-prompt", SUMMARY_PROMPT, "--output-format", "text"];
      const child = (this.opts.spawn ?? nodeSpawn)("claude", args, { cwd: this.opts.scratch, env: summaryEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
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
        settle(new Error(timedOut ? "timed out" : `claude exited ${code ?? signal}: ${err.trim().slice(0, 300)}`));
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
    });
  }

  /**
   * Wait until `done()`, at most `ms`, while summaries for any chat finish. Another chat may hold every
   * slot, so this chat's runnable work waits for progress anywhere. A failed call waits for the next
   * message, so when this chat has nothing else to run it gets that retry here, at most 3 rounds.
   * False on timeout, abort, dispose, or calls that keep failing.
   */
  async waitUntil(chat: Chat, done: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(Math.min(ms, 2 ** 31 - 1));
    const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
    for (let rounds = 0; !done(); ) {
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
    for (const child of this.procs) child.kill("SIGKILL");
    this.changed.emit("progress");
  }
}
