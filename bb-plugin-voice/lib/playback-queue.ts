const STARTUP_BUFFER_CHUNKS = 2;
const STARTUP_BUFFER_TIMEOUT_MS = 1_500;
const FADE_SECONDS = 0.04;

export interface PlaybackChunk {
  id: string;
  index: number;
}

interface QueueEntry {
  id: string;
  index: number;
  epoch: number;
  state: "fetching" | "decoding" | "buffered" | "scheduled" | "played";
  controller: AbortController | null;
  buffer: AudioBuffer | null;
}

interface PlaybackQueueIo {
  fetchChunk(id: string, signal: AbortSignal): Promise<ArrayBuffer>;
  onChunkPlayed(index: number): void;
  onFinished(): void;
  onInterrupted(): void;
  onError(error: Error): void;
}

interface ScheduledChunk {
  epoch: number;
  index: number;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/** Owns the Web Audio timeline. PlaybackQueue is the only caller. */
class ChunkScheduler {
  private readonly scheduled = new Map<number, ScheduledChunk>();
  private lastScheduledEnd = 0;

  constructor(private readonly context: AudioContext) {}

  enqueue(
    index: number,
    epoch: number,
    buffer: AudioBuffer,
    onEnded: () => void,
  ): void {
    const startAt = Math.max(this.context.currentTime, this.lastScheduledEnd);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(1, startAt);
    source.connect(gain);
    gain.connect(this.context.destination);

    const scheduled: ScheduledChunk = { epoch, index, source, gain };
    this.scheduled.set(index, scheduled);
    this.lastScheduledEnd = startAt + Math.max(0, buffer.duration);
    source.onended = () => {
      if (this.scheduled.get(index) !== scheduled) return;
      this.scheduled.delete(index);
      if (this.scheduled.size === 0) this.lastScheduledEnd = 0;
      onEnded();
    };
    source.start(startAt);
  }

  fadeStop(): void {
    if (this.scheduled.size === 0) {
      this.lastScheduledEnd = 0;
      return;
    }

    const now = this.context.currentTime;
    const stopAt = now + FADE_SECONDS;
    for (const scheduled of this.scheduled.values()) {
      const gain = scheduled.gain.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, stopAt);
      scheduled.source.onended = null;
      try {
        scheduled.source.stop(stopAt);
      } catch {
        // A source that ended between the map read and stop is already silent.
      }
    }
    this.scheduled.clear();
    this.lastScheduledEnd = 0;
  }
}

/**
 * The single frontend owner of backend chunks, from fetch through played.
 * Snapshots are deliberately the only input: the backend remains authoritative
 * about which unplayed chunks are still available.
 */
export class PlaybackQueue {
  private readonly scheduler: ChunkScheduler;
  private readonly lifecycle = new Map<string, QueueEntry>();
  private epoch = 0;
  private streamComplete = false;
  private startupReady = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private finishedNotified = false;
  private failureLatched = false;
  private freshAfterStop = false;
  private lastPlayedIndex = -1;

  constructor(
    private readonly context: AudioContext,
    private readonly io: PlaybackQueueIo,
  ) {
    this.scheduler = new ChunkScheduler(context);
  }

  /**
   * Applies one authoritative owner snapshot. An interruption and its new
   * epoch's ingestion happen in this same call so no ping can be lost between
   * the two operations.
   */
  applySnapshot(chunks: PlaybackChunk[], streamComplete: boolean): void {
    if (this.freshAfterStop && chunks.length > 0) {
      this.lastPlayedIndex = -1;
      this.freshAfterStop = false;
      this.failureLatched = false;
    }
    if (this.failureLatched) return;

    const next = new Map<string, PlaybackChunk>();
    for (const chunk of chunks) {
      if (!next.has(chunk.id)) next.set(chunk.id, chunk);
    }

    const removedPrePlayed = [...this.lifecycle.values()].some(
      (entry) => entry.state !== "played" && !next.has(entry.id),
    );
    if (removedPrePlayed && !streamComplete) {
      this.interrupt();
    } else {
      for (const [id, entry] of this.lifecycle) {
        if (!next.has(id)) this.dropEntry(entry);
      }
    }

    const wasStreamComplete = this.streamComplete;
    this.streamComplete = streamComplete;
    if (!streamComplete) {
      this.finishedNotified = false;
      if (wasStreamComplete) this.startupReady = false;
    }

    for (const chunk of next.values()) {
      const existing = this.lifecycle.get(chunk.id);
      if (existing) {
        existing.index = chunk.index;
        continue;
      }
      this.startChunk(chunk);
    }

    this.maybeSchedule();
    this.checkFinished();
  }

  /** Stops all current work while preserving the final played index for cancel. */
  stop(): void {
    this.epoch += 1;
    this.abortFetches();
    this.scheduler.fadeStop();
    this.lifecycle.clear();
    this.clearStartupTimer();
    this.streamComplete = false;
    this.startupReady = false;
    this.finishedNotified = false;
    this.failureLatched = false;
    this.freshAfterStop = true;
  }

  /** The largest naturally completed global chunk index, or zero if none. */
  playedThroughIndex(): number {
    return Math.max(0, this.lastPlayedIndex);
  }

  private startChunk(chunk: PlaybackChunk): void {
    const entry: QueueEntry = {
      id: chunk.id,
      index: chunk.index,
      epoch: this.epoch,
      state: "fetching",
      controller: new AbortController(),
      buffer: null,
    };
    this.lifecycle.set(entry.id, entry);
    void this.fetchAndDecode(entry);
  }

  private async fetchAndDecode(entry: QueueEntry): Promise<void> {
    try {
      const bytes = await this.io.fetchChunk(entry.id, entry.controller!.signal);
      if (!this.isCurrent(entry)) return;

      entry.state = "decoding";
      const buffer = await this.context.decodeAudioData(bytes);
      if (!this.isCurrent(entry)) return;

      entry.buffer = buffer;
      entry.controller = null;
      entry.state = "buffered";
      this.maybeSchedule();
    } catch (error) {
      if (!this.isCurrent(entry)) return;
      this.fail(error);
    }
  }

  private isCurrent(entry: QueueEntry): boolean {
    return (
      !this.failureLatched &&
      entry.epoch === this.epoch &&
      this.lifecycle.get(entry.id) === entry &&
      !entry.controller?.signal.aborted
    );
  }

  private maybeSchedule(): void {
    if (this.failureLatched) return;

    const bufferedCount = [...this.lifecycle.values()].filter(
      (entry) => entry.state === "buffered",
    ).length;
    if (!this.streamComplete && !this.startupReady) {
      if (bufferedCount < STARTUP_BUFFER_CHUNKS) {
        if (bufferedCount > 0) this.ensureStartupTimer();
        return;
      }
      this.startupReady = true;
      this.clearStartupTimer();
    } else if (this.streamComplete) {
      this.startupReady = true;
      this.clearStartupTimer();
    }

    const entries = [...this.lifecycle.values()].sort(
      (left, right) => left.index - right.index,
    );
    for (const entry of entries) {
      if (entry.state === "fetching" || entry.state === "decoding") break;
      if (entry.state !== "buffered") continue;
      if (!entry.buffer) {
        this.fail(new Error("decoded chunk has no audio buffer"));
        return;
      }

      entry.state = "scheduled";
      try {
        this.scheduler.enqueue(
          entry.index,
          entry.epoch,
          entry.buffer,
          () => this.handleChunkEnded(entry),
        );
      } catch (error) {
        entry.state = "buffered";
        this.fail(error);
        return;
      }
    }
  }

  private handleChunkEnded(entry: QueueEntry): void {
    if (!this.isCurrent(entry) || entry.state !== "scheduled") return;

    entry.state = "played";
    entry.buffer = null;
    this.lastPlayedIndex = Math.max(this.lastPlayedIndex, entry.index);
    this.io.onChunkPlayed(entry.index);
    this.maybeSchedule();
    this.checkFinished();
  }

  private checkFinished(): void {
    if (this.failureLatched || !this.streamComplete || this.finishedNotified) {
      return;
    }
    if ([...this.lifecycle.values()].some((entry) => entry.state !== "played")) {
      return;
    }
    this.finishedNotified = true;
    this.io.onFinished();
  }

  private ensureStartupTimer(): void {
    if (this.startupTimer !== null) return;
    const epoch = this.epoch;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.epoch !== epoch || this.streamComplete || this.failureLatched) {
        return;
      }
      this.startupReady = true;
      this.maybeSchedule();
    }, STARTUP_BUFFER_TIMEOUT_MS);
  }

  private clearStartupTimer(): void {
    if (this.startupTimer === null) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private interrupt(): void {
    this.epoch += 1;
    this.abortFetches();
    this.scheduler.fadeStop();
    this.lifecycle.clear();
    this.clearStartupTimer();
    this.startupReady = false;
    this.finishedNotified = false;
    this.io.onInterrupted();
  }

  private abortFetches(): void {
    for (const entry of this.lifecycle.values()) {
      if (!entry.controller) continue;
      entry.controller.abort(new Error("voice playback epoch ended"));
      entry.controller = null;
    }
  }

  private dropEntry(entry: QueueEntry): void {
    if (entry.controller) {
      entry.controller.abort(new Error("voice chunk is no longer available"));
      entry.controller = null;
    }
    this.lifecycle.delete(entry.id);
  }

  private fail(error: unknown): void {
    if (this.failureLatched) return;
    this.failureLatched = true;
    this.epoch += 1;
    this.abortFetches();
    this.scheduler.fadeStop();
    this.lifecycle.clear();
    this.clearStartupTimer();
    this.streamComplete = false;
    this.startupReady = false;
    this.finishedNotified = false;
    this.io.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
