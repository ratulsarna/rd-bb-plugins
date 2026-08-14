import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackQueue, type PlaybackChunk } from "../lib/playback-queue";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

class FakeGainParam {
  value = 1;
  readonly calls: Array<{ kind: string; value: number; at: number }> = [];

  setValueAtTime(value: number, at: number): void {
    this.value = value;
    this.calls.push({ kind: "set", value, at });
  }

  cancelScheduledValues(at: number): void {
    this.calls.push({ kind: "cancel", value: 0, at });
  }

  linearRampToValueAtTime(value: number, at: number): void {
    this.value = value;
    this.calls.push({ kind: "ramp", value, at });
  }
}

class FakeGainNode {
  readonly gain = new FakeGainParam();

  connect(): void {}
}

class FakeSourceNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startAt: number | null = null;
  stopAt: number | null = null;
  readonly gain: FakeGainNode;

  constructor(gain: FakeGainNode) {
    this.gain = gain;
  }

  connect(): void {}

  start(at: number): void {
    this.startAt = at;
  }

  stop(at: number): void {
    this.stopAt = at;
  }

  finish(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  currentTime = 0;
  readonly destination = {} as AudioNode;
  readonly sources: FakeSourceNode[] = [];
  readonly decodes: Array<Deferred<AudioBuffer>> = [];

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSourceNode(new FakeGainNode());
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    return this.sources.at(-1)?.gain as unknown as GainNode;
  }

  decodeAudioData(_bytes: ArrayBuffer): Promise<AudioBuffer> {
    const result = deferred<AudioBuffer>();
    this.decodes.push(result);
    return result.promise;
  }

  buffer(duration: number): AudioBuffer {
    return { duration } as AudioBuffer;
  }
}

function chunk(id: string, index: number): PlaybackChunk {
  return { id, index };
}

function setup() {
  const context = new FakeAudioContext();
  const fetches = new Map<string, Deferred<ArrayBuffer>>();
  const fetchCalls: Array<{ id: string; signal: AbortSignal }> = [];
  const events = {
    played: [] as number[],
    finished: 0,
    interrupted: 0,
    errors: [] as Error[],
  };
  const queue = new PlaybackQueue(context as unknown as AudioContext, {
    fetchChunk: (id, signal) => {
      const pending = deferred<ArrayBuffer>();
      fetches.set(id, pending);
      fetchCalls.push({ id, signal });
      return pending.promise;
    },
    onChunkPlayed: (index) => events.played.push(index),
    onFinished: () => {
      events.finished += 1;
    },
    onInterrupted: () => {
      events.interrupted += 1;
    },
    onError: (error) => events.errors.push(error),
  });
  return { context, fetches, fetchCalls, events, queue };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function resolveFetch(
  fetches: Map<string, Deferred<ArrayBuffer>>,
  id: string,
): void {
  fetches.get(id)?.resolve(new ArrayBuffer(1));
}

describe("PlaybackQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("starts each unseen chunk once across overlapping snapshots", async () => {
    const { fetches, fetchCalls, queue } = setup();

    queue.applySnapshot([chunk("a", 0), chunk("b", 1)], false);
    queue.applySnapshot([chunk("a", 0), chunk("b", 1)], false);

    expect(fetchCalls.map((call) => call.id)).toEqual(["a", "b"]);
    expect(fetches.size).toBe(2);
    resolveFetch(fetches, "a");
    resolveFetch(fetches, "b");
    await settle();
    expect(fetchCalls).toHaveLength(2);
  });

  it("waits for an earlier decode before scheduling a later one", async () => {
    const { context, fetches, queue } = setup();
    queue.applySnapshot([chunk("a", 0), chunk("b", 1)], true);
    resolveFetch(fetches, "a");
    resolveFetch(fetches, "b");
    await settle();

    context.decodes[1]!.resolve(context.buffer(1));
    await settle();
    expect(context.sources).toHaveLength(0);

    context.decodes[0]!.resolve(context.buffer(1));
    await settle();
    expect(context.sources.map((source) => source.startAt)).toEqual([0, 1]);
  });

  it("does not enqueue a fetch that resolves after Stop", async () => {
    const { context, fetches, fetchCalls, events, queue } = setup();
    queue.applySnapshot([chunk("a", 0)], true);
    const signal = fetchCalls[0]!.signal;
    queue.stop();
    fetches.get("a")!.resolve(new ArrayBuffer(1));
    await settle();

    expect(signal.aborted).toBe(true);
    expect(context.sources).toHaveLength(0);
    expect(events.errors).toHaveLength(0);
  });

  it("does not enqueue a decode that resolves after Stop", async () => {
    const { context, fetches, events, queue } = setup();
    queue.applySnapshot([chunk("a", 0)], true);
    resolveFetch(fetches, "a");
    await settle();
    expect(context.decodes).toHaveLength(1);

    queue.stop();
    context.decodes[0]!.resolve(context.buffer(1));
    await settle();

    expect(context.sources).toHaveLength(0);
    expect(events.errors).toHaveLength(0);
  });

  it("does not enqueue a decode that resolves after interruption", async () => {
    const { context, fetches, events, queue } = setup();
    queue.applySnapshot([chunk("old", 0)], true);
    resolveFetch(fetches, "old");
    await settle();
    expect(context.decodes).toHaveLength(1);

    queue.applySnapshot([chunk("new", 1)], false);
    context.decodes[0]!.resolve(context.buffer(1));
    resolveFetch(fetches, "new");
    await settle();

    expect(events.interrupted).toBe(1);
    expect(context.sources).toHaveLength(0);
    expect(events.errors).toHaveLength(0);
  });

  it("handles removal and new-epoch ingestion atomically", async () => {
    const { context, fetches, fetchCalls, events, queue } = setup();
    queue.applySnapshot([chunk("old", 0)], true);
    resolveFetch(fetches, "old");
    await settle();
    context.decodes[0]!.resolve(context.buffer(1));
    await settle();
    expect(context.sources).toHaveLength(1);

    queue.applySnapshot([chunk("new", 1)], false);
    expect(events.interrupted).toBe(1);
    expect(fetchCalls.map((call) => call.id)).toEqual(["old", "new"]);
    resolveFetch(fetches, "new");
    await settle();
    context.decodes[1]!.resolve(context.buffer(1));
    await settle();

    expect(context.sources).toHaveLength(1);
    queue.applySnapshot([chunk("new", 1)], true);
    expect(context.sources).toHaveLength(2);
    expect(context.sources[1]!.startAt).toBe(0);
  });

  it("holds a short first buffer until two chunks or the startup timeout", async () => {
    vi.useFakeTimers();
    const { context, fetches, queue } = setup();
    queue.applySnapshot([chunk("a", 0)], false);
    resolveFetch(fetches, "a");
    await settle();
    context.decodes[0]!.resolve(context.buffer(0.2));
    await settle();

    expect(context.sources).toHaveLength(0);
    vi.advanceTimersByTime(1_499);
    expect(context.sources).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(context.sources).toHaveLength(1);
  });

  it("flushes one buffered final chunk when streamComplete arrives", async () => {
    const { context, fetches, events, queue } = setup();
    queue.applySnapshot([chunk("final", 0)], false);
    resolveFetch(fetches, "final");
    await settle();
    context.decodes[0]!.resolve(context.buffer(0.5));
    await settle();
    expect(context.sources).toHaveLength(0);

    queue.applySnapshot([chunk("final", 0)], true);
    expect(context.sources).toHaveLength(1);
    context.sources[0]!.finish();
    expect(events.played).toEqual([0]);
    expect(events.finished).toBe(1);
  });

  it("waits for every pre-played state before finishing", async () => {
    const { context, fetches, events, queue } = setup();
    queue.applySnapshot([chunk("a", 0)], true);
    expect(events.finished).toBe(0);
    resolveFetch(fetches, "a");
    await settle();
    expect(events.finished).toBe(0);
    context.decodes[0]!.resolve(context.buffer(0.5));
    await settle();
    expect(events.finished).toBe(0);
    context.sources[0]!.finish();
    expect(events.finished).toBe(1);
  });

  it("latches a current-epoch fetch failure and tears down once", async () => {
    const { context, fetches, events, queue } = setup();
    queue.applySnapshot([chunk("a", 0), chunk("b", 1)], true);
    fetches.get("a")!.reject(new Error("fetch failed"));
    await settle();

    expect(events.errors).toHaveLength(1);
    expect(events.errors[0]!.message).toBe("fetch failed");
    expect(fetches.get("b")!.promise).toBeDefined();
    fetches.get("b")!.reject(new Error("second failure"));
    await settle();
    expect(events.errors).toHaveLength(1);
    expect(context.sources).toHaveLength(0);
  });

  it("latches a current-epoch decode failure and tears down once", async () => {
    const { context, fetches, events, queue } = setup();
    queue.applySnapshot([chunk("a", 0)], true);
    resolveFetch(fetches, "a");
    await settle();
    context.decodes[0]!.reject(new Error("decode failed"));
    await settle();

    expect(events.errors.map((error) => error.message)).toEqual(["decode failed"]);
    expect(context.sources).toHaveLength(0);
  });

  it("silently discards a stale rejection after interruption", async () => {
    const { fetches, events, queue } = setup();
    queue.applySnapshot([chunk("old", 0)], false);
    queue.applySnapshot([], false);
    fetches.get("old")!.reject(new Error("stale failure"));
    await settle();

    expect(events.interrupted).toBe(1);
    expect(events.errors).toHaveLength(0);
  });

  it("schedules while playing without overlap and starts after a drained queue at now", async () => {
    const { context, fetches, queue } = setup();
    context.currentTime = 10;
    queue.applySnapshot([chunk("a", 0)], true);
    resolveFetch(fetches, "a");
    await settle();
    context.decodes[0]!.resolve(context.buffer(1));
    await settle();
    expect(context.sources[0]!.startAt).toBe(10);

    queue.applySnapshot([chunk("a", 0), chunk("b", 1)], true);
    resolveFetch(fetches, "b");
    await settle();
    context.decodes[1]!.resolve(context.buffer(1));
    await settle();
    expect(context.sources[1]!.startAt).toBe(11);

    context.currentTime = 11;
    context.sources[0]!.finish();
    context.sources[1]!.finish();
    queue.applySnapshot([chunk("c", 2)], true);
    resolveFetch(fetches, "c");
    await settle();
    context.decodes[2]!.resolve(context.buffer(0.5));
    await settle();
    expect(context.sources[2]!.startAt).toBe(11);
  });

  it("fades a playing source at the shared clock during interruption", async () => {
    const { context, fetches, queue } = setup();
    context.currentTime = 3;
    queue.applySnapshot([chunk("a", 0)], true);
    resolveFetch(fetches, "a");
    await settle();
    context.decodes[0]!.resolve(context.buffer(10));
    await settle();

    queue.applySnapshot([], false);

    expect(context.sources[0]!.stopAt).toBeCloseTo(3.04, 5);
    expect(context.sources[0]!.gain.gain.calls.at(-1)).toEqual({
      kind: "ramp",
      value: 0,
      at: 3.04,
    });
  });
});
