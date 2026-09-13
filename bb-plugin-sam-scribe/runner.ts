// Turns a stream of idle events into scribe runs: wait for a quiet window per
// thread, then read threads one at a time. The scribe script owns the cursor
// and the note; this only decides when to call it.

export interface RunnerOptions {
  /** Read fresh on every idle so a settings change applies without a reload. */
  quietMs: () => number;
  /** `null` means every Sam thread, the hourly sweep. */
  run: (threadIds: string[] | null, signal: AbortSignal) => Promise<void>;
  log: { error(message: string): void };
}

export class ScribeRunner {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private pending: Array<string | null> = [];
  private draining = false;
  private disposed = false;
  private readonly controller = new AbortController();

  private readonly opts: RunnerOptions;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  /** A Sam thread went idle. Another idle inside the window restarts the wait. */
  touch(threadId: string): void {
    if (this.disposed) return;
    this.cancel(threadId);
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      this.enqueue(threadId);
    }, this.opts.quietMs());
    this.timers.set(threadId, timer);
  }

  /** The thread woke up or went away. A run already in progress finishes; the cursor makes that safe. */
  cancel(threadId: string): void {
    const timer = this.timers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(threadId);
    }
    this.pending = this.pending.filter((id) => id !== threadId);
  }

  /** Read every Sam thread, catching anything an idle event missed. */
  sweep(): void {
    this.enqueue(null);
  }

  get waiting(): number {
    return this.timers.size + this.pending.length;
  }

  private enqueue(item: string | null): void {
    if (this.disposed || this.pending.includes(item)) return;
    this.pending.push(item);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0 && !this.disposed) {
        const item = this.pending.shift() as string | null;
        try {
          await this.opts.run(item === null ? null : [item], this.controller.signal);
        } catch (error) {
          this.opts.log.error(`scribe run failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending = [];
    this.controller.abort();
  }
}
