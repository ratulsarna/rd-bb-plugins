import type { BbPluginApi } from "@bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import voicePlugin from "../server";
import type { VoiceEventRow } from "../lib/correlation";

type ThreadStatus = "idle" | "active" | "error";
type RpcHandlers = {
  getState(input: Identity): VoiceState;
  reserve(input: Identity): Promise<ReserveResult>;
  ackPlayback(input: PlayedMutation): { ok: boolean };
  cancel(input: CancelMutation): { ok: boolean };
  finishPlayback(input: PlayedMutation): { ok: boolean };
};
type EventHandler = (payload: Record<string, unknown>) => void;
type SubscriptionHandler = (event: Record<string, unknown>) => void;
type HttpHandler = (context: TestHttpContext) => Response | Promise<Response>;

interface Identity {
  threadId: string;
  controllerId: string;
}

interface Mutation extends Identity {
  exchangeId: string;
}

interface PlayedMutation extends Mutation {
  playedThroughIndex: number;
}

interface CancelMutation extends Mutation {
  playedThroughIndex?: number;
}

interface ReserveResult {
  ok: boolean;
  exchangeId?: string;
  reason?: string;
}

interface VoiceState {
  phase: "ready" | "listening" | "working" | "speaking" | "failed";
  canControl: boolean;
  exchangeId: string | null;
  error: string | null;
  chunks: { id: string; index: number }[];
  streamComplete: boolean;
}

interface Interaction {
  status: "pending" | "resolved";
  turnId: string | null;
  payload: { kind: "approval" | "user_question" | "plugin" };
}

interface TestHttpContext {
  req: {
    raw: Request;
    query(name: string): string | undefined;
  };
  json(body: unknown, status?: number): Response;
}

const owner = { threadId: "thread-1", controllerId: "controller-1" };
const other = { threadId: "thread-1", controllerId: "controller-2" };
const threadScope = { kind: "thread" } as const;
const turnScope = { kind: "turn", turnId: "turn-voice" } as const;

function row(
  seq: number,
  type: string,
  scope: VoiceEventRow["scope"],
  data: unknown,
): VoiceEventRow {
  return { seq, type, scope, data };
}

function voiceRows({ answer = "Voice answer" }: { answer?: string | null } = {}) {
  const rows: VoiceEventRow[] = [
    row(11, "client/turn/requested", threadScope, {
      requestId: "request-voice",
      initiator: "user",
      input: [{ type: "text", text: "voice transcript" }],
    }),
    row(12, "turn/input/accepted", turnScope, {
      clientRequestId: "request-voice",
    }),
  ];
  if (answer !== null) {
    rows.push(
      row(13, "item/completed", turnScope, {
        item: { type: "agentMessage", id: "answer-1", text: answer },
      }),
    );
  }
  return rows;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortableRequest(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => reject(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function createHarness() {
  let rpc: RpcHandlers | null = null;
  let threadStatus: ThreadStatus = "idle";
  let interactions: Interaction[] = [];
  let events = voiceRows();
  let sendError: Error | null = null;
  let onSend: (() => void | Promise<void>) | null = () => {
    threadStatus = "active";
  };
  let eventLoader: ((afterSeq: string) => Promise<VoiceEventRow[]>) | null = null;
  let threadLoader: ((call: number) => Promise<ThreadStatus>) | null = null;
  const eventHandlers = new Map<string, EventHandler>();
  const subscriptions = new Map<string, SubscriptionHandler>();
  const routes = new Map<string, HttpHandler>();
  const disposeHooks: Array<() => void | Promise<void>> = [];
  const published: Array<{ channel: string; payload: unknown }> = [];
  const publishedStates: VoiceState[] = [];
  const sends: unknown[] = [];
  const eventListCalls: string[] = [];
  let threadGetCalls = 0;
  let interactionListCalls = 0;

  const bb = {
    settings: {
      define() {
        return { get: async () => ({ speechServiceUrl: "http://speech.test" }) };
      },
    },
    realtime: {
      publish(channel: string, payload: unknown) {
        published.push({ channel, payload });
        if (rpc) publishedStates.push(rpc.getState(owner));
      },
    },
    rpc: {
      register(_contract: unknown, handlers: RpcHandlers) {
        rpc = handlers;
      },
    },
    http: {
      route(method: string, path: string, handler: HttpHandler) {
        routes.set(`${method} ${path}`, handler);
      },
    },
    events: {
      on(event: string, handler: EventHandler) {
        eventHandlers.set(event, handler);
      },
    },
    sdk: {
      threads: {
        async get() {
          threadGetCalls += 1;
          const status = threadLoader
            ? await threadLoader(threadGetCalls)
            : threadStatus;
          return { id: owner.threadId, status };
        },
        interactions: {
          async list() {
            interactionListCalls += 1;
            return interactions;
          },
        },
        async timeline() {
          return { maxSeq: 10 };
        },
        async send(input: unknown) {
          sends.push(input);
          if (sendError) throw sendError;
          await onSend?.();
          return { ok: true };
        },
        events: {
          async list(input: { afterSeq: string }) {
            eventListCalls.push(input.afterSeq);
            if (eventLoader) return eventLoader(input.afterSeq);
            return events.filter((event) => event.seq > Number(input.afterSeq));
          },
        },
      },
      subscribe({
        event,
        callback,
      }: {
        event: string;
        callback: SubscriptionHandler;
      }) {
        subscriptions.set(event, callback);
        return () => subscriptions.delete(event);
      },
    },
    onDispose(hook: () => void | Promise<void>) {
      disposeHooks.push(hook);
    },
  } as unknown as BbPluginApi;

  voicePlugin(bb);
  const api = rpc as RpcHandlers | null;
  if (!api) throw new Error("voice RPC was not registered");

  const request = (
    method: "POST" | "GET",
    path: "/audio",
    query: Record<string, string>,
    body = new Uint8Array(),
  ) => {
    const handler = routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`missing route ${method} ${path}`);
    const params = new URLSearchParams(query);
    const raw = new Request(`http://plugin.test${path}?${params}`, {
      method,
      body: method === "POST" ? body : undefined,
      duplex: method === "POST" ? "half" : undefined,
    } as RequestInit);
    return handler({
      req: { raw, query: (name) => params.get(name) ?? undefined },
      json: (value, status = 200) => jsonResponse(value, status),
    });
  };

  return {
    api,
    sends,
    published,
    publishedStates,
    eventListCalls,
    get threadGetCalls() {
      return threadGetCalls;
    },
    get interactionListCalls() {
      return interactionListCalls;
    },
    setThreadStatus(status: ThreadStatus) {
      threadStatus = status;
    },
    setInteractions(next: Interaction[]) {
      interactions = next;
    },
    setEvents(next: VoiceEventRow[]) {
      events = next;
    },
    setEventLoader(loader: (afterSeq: string) => Promise<VoiceEventRow[]>) {
      eventLoader = loader;
    },
    setThreadLoader(loader: (call: number) => Promise<ThreadStatus>) {
      threadLoader = loader;
    },
    setSendError(error: Error | null) {
      sendError = error;
    },
    setOnSend(callback: (() => void | Promise<void>) | null) {
      onSend = callback;
    },
    emit(event: "thread.idle" | "thread.failed", payload: Record<string, unknown>) {
      eventHandlers.get(event)?.(payload);
    },
    changeThread(changes: string[], eventTypes?: string[]) {
      subscriptions.get("thread:changed")?.({
        id: owner.threadId,
        changes,
        ...(eventTypes ? { metadata: { eventTypes } } : {}),
      });
    },
    reconnect() {
      subscriptions.get("realtime:connection")?.({
        state: "connected",
        reconnected: true,
      });
    },
    upload(exchangeId: string, controllerId = owner.controllerId) {
      return request("POST", "/audio", {
        exchangeId,
        controllerId,
        mimeType: "audio/wav",
      }, new Uint8Array([1, 2, 3]));
    },
    getAudio(audioId: string) {
      return request("GET", "/audio", { id: audioId });
    },
    async dispose() {
      for (const hook of [...disposeHooks].reverse()) await hook();
    },
  };
}

async function reserve(harness: ReturnType<typeof createHarness>, identity = owner) {
  const result = await harness.api.reserve(identity);
  expect(result.ok).toBe(true);
  if (!result.exchangeId) throw new Error("reservation returned no exchange id");
  return result.exchangeId;
}

async function state(harness: ReturnType<typeof createHarness>, identity = owner) {
  return harness.api.getState(identity);
}

async function waitForPhase(
  harness: ReturnType<typeof createHarness>,
  phase: VoiceState["phase"],
) {
  await vi.waitFor(async () => {
    expect((await state(harness)).phase).toBe(phase);
  });
  return state(harness);
}

async function beginUpload(harness: ReturnType<typeof createHarness>) {
  const exchangeId = await reserve(harness);
  expect((await harness.upload(exchangeId)).status).toBe(202);
  return exchangeId;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/audio/transcriptions")) {
        return jsonResponse({ text: "voice transcript" });
      }
      if (url.endsWith("/v1/audio/speech")) {
        return new Response(new Uint8Array([82, 73, 70, 70]), {
          headers: { "content-type": "audio/wav" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("voice backend state machine", () => {
  it("reads ready state without querying the thread or its interactions", async () => {
    const harness = createHarness();

    expect(await state(harness)).toEqual({
      phase: "ready",
      canControl: false,
      exchangeId: null,
      error: null,
      chunks: [],
      streamComplete: false,
    });
    expect(harness.threadGetCalls).toBe(0);
    expect(harness.interactionListCalls).toBe(0);
    await harness.dispose();
  });

  it("sends nothing for an empty transcript", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ text: "  \n" }));
    const harness = createHarness();
    await beginUpload(harness);

    const failed = await waitForPhase(harness, "failed");
    expect(failed.error).toBe("nothing transcribed");
    expect(harness.sends).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await harness.dispose();
  });

  it("fails before send when transcription errors or times out", async () => {
    const errorHarness = createHarness();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, 503));
    await beginUpload(errorHarness);
    expect((await waitForPhase(errorHarness, "failed")).error).toContain("HTTP 503");
    expect(errorHarness.sends).toHaveLength(0);
    await errorHarness.dispose();

    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce((_input, init) =>
      abortableRequest(init?.signal),
    );
    const timeoutHarness = createHarness();
    await beginUpload(timeoutHarness);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await waitForPhase(timeoutHarness, "failed")).error).toContain(
      "timed out",
    );
    expect(timeoutHarness.sends).toHaveLength(0);
    await timeoutHarness.dispose();
  });

  it("records a mode:start rejection as a failed exchange", async () => {
    const harness = createHarness();
    harness.setSendError(new Error("thread is active"));
    await beginUpload(harness);

    const failed = await waitForPhase(harness, "failed");
    expect(failed.error).toBe("thread is active");
    expect(harness.sends).toEqual([
      {
        threadId: owner.threadId,
        mode: "start",
        input: [{ type: "text", text: "voice transcript", mentions: [] }],
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await harness.dispose();
  });

  it("fails after send when synthesis errors or times out", async () => {
    const errorHarness = createHarness();
    errorHarness.setOnSend(() => errorHarness.setThreadStatus("idle"));
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ text: "voice transcript" }));
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, 503));
    await beginUpload(errorHarness);
    expect((await waitForPhase(errorHarness, "failed")).error).toContain("HTTP 503");
    expect(errorHarness.sends).toHaveLength(1);
    await errorHarness.dispose();

    vi.useFakeTimers();
    const timeoutHarness = createHarness();
    timeoutHarness.setOnSend(() => timeoutHarness.setThreadStatus("idle"));
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ text: "voice transcript" }));
    vi.mocked(fetch).mockImplementationOnce((_input, init) =>
      abortableRequest(init?.signal),
    );
    await beginUpload(timeoutHarness);
    await vi.advanceTimersByTimeAsync(180_000);
    expect((await waitForPhase(timeoutHarness, "failed")).error).toContain(
      "timed out",
    );
    expect(timeoutHarness.sends).toHaveLength(1);
    await timeoutHarness.dispose();
  });

  it("publishes ready state while disposing a working exchange", async () => {
    const harness = createHarness();
    await beginUpload(harness);
    await vi.waitFor(() => expect(harness.sends).toHaveLength(1));
    expect((await state(harness)).phase).toBe("working");
    const publishCount = harness.published.length;

    await harness.dispose();

    expect(harness.published).toHaveLength(publishCount + 1);
    expect(harness.published.at(-1)).toEqual({
      channel: "voice:changed",
      payload: { threadId: owner.threadId },
    });
    expect(harness.publishedStates.at(-1)?.phase).toBe("ready");
  });

  it("ends quietly for a pending interaction or a turn with no answer", async () => {
    const interactionHarness = createHarness();
    interactionHarness.setOnSend(() => {
      interactionHarness.setThreadStatus("active");
      interactionHarness.setInteractions([
        {
          status: "pending",
          turnId: null,
          payload: { kind: "plugin" },
        },
      ]);
    });
    await beginUpload(interactionHarness);
    await waitForPhase(interactionHarness, "ready");
    expect(fetch).toHaveBeenCalledTimes(1);
    await interactionHarness.dispose();

    vi.mocked(fetch).mockClear();
    const noAnswerHarness = createHarness();
    noAnswerHarness.setEvents(voiceRows({ answer: null }));
    noAnswerHarness.setOnSend(() => noAnswerHarness.setThreadStatus("idle"));
    await beginUpload(noAnswerHarness);
    await waitForPhase(noAnswerHarness, "ready");
    expect(noAnswerHarness.sends).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await noAnswerHarness.dispose();
  });

  it("fails on thread.failed after request resolution", async () => {
    const harness = createHarness();
    await beginUpload(harness);
    await vi.waitFor(() => expect(harness.threadGetCalls).toBeGreaterThanOrEqual(2));

    harness.emit("thread.failed", {
      thread: { id: owner.threadId },
      error: "provider stopped",
    });
    const failed = await waitForPhase(harness, "failed");
    expect(failed.error).toBe("provider stopped");
    expect(fetch).toHaveBeenCalledTimes(1);
    await harness.dispose();
  });

  it("reconciles a failure that lands before request-id resolution", async () => {
    let resolveEvents!: (rows: VoiceEventRow[]) => void;
    const eventPage = new Promise<VoiceEventRow[]>((resolve) => {
      resolveEvents = resolve;
    });
    const harness = createHarness();
    harness.setEventLoader(() => eventPage);
    await beginUpload(harness);
    await vi.waitFor(() => expect(harness.eventListCalls).toEqual(["10"]));

    harness.setThreadStatus("error");
    harness.emit("thread.failed", {
      thread: { id: owner.threadId },
      error: "failed before correlation",
    });
    resolveEvents(voiceRows());

    const failed = await waitForPhase(harness, "failed");
    expect(failed.error).toBe("thread turn failed");
    expect(fetch).toHaveBeenCalledTimes(1);
    await harness.dispose();
  });

  it("does not treat an active turn's completed message as terminal", async () => {
    const harness = createHarness();
    await beginUpload(harness);
    await vi.waitFor(() => expect(harness.threadGetCalls).toBeGreaterThanOrEqual(2));
    const waiting = await state(harness);
    expect(waiting.chunks).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);

    harness.setThreadStatus("idle");
    harness.emit("thread.idle", {
      thread: { id: owner.threadId },
      lastAssistantText: "Voice answer",
    });
    await waitForPhase(harness, "speaking");
    expect(fetch).toHaveBeenCalledTimes(2);
    await harness.dispose();
  });

  it("remembers idle while an active reconciliation read is in flight", async () => {
    let resolveStatus!: (status: ThreadStatus) => void;
    const delayedStatus = new Promise<ThreadStatus>((resolve) => {
      resolveStatus = resolve;
    });
    const harness = createHarness();
    harness.setThreadLoader((call) =>
      call === 1 ? Promise.resolve("idle") : delayedStatus,
    );
    await beginUpload(harness);
    await vi.waitFor(() => expect(harness.threadGetCalls).toBe(2));

    harness.emit("thread.idle", { thread: { id: owner.threadId } });
    resolveStatus("active");

    await waitForPhase(harness, "speaking");
    expect(fetch).toHaveBeenCalledTimes(2);
    await harness.dispose();
  });

  it("ignores idle before send and resolves duplicate idle events once", async () => {
    let resolveStt!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((resolve) => {
        resolveStt = resolve;
      }),
    );
    const harness = createHarness();
    await beginUpload(harness);
    harness.emit("thread.idle", {
      thread: { id: owner.threadId },
      lastAssistantText: "unrelated",
    });
    expect(harness.sends).toHaveLength(0);

    resolveStt(jsonResponse({ text: "voice transcript" }));
    await vi.waitFor(() => expect(harness.sends).toHaveLength(1));
    harness.setThreadStatus("idle");
    harness.emit("thread.idle", { thread: { id: owner.threadId } });
    harness.emit("thread.idle", { thread: { id: owner.threadId } });

    await waitForPhase(harness, "speaking");
    expect(fetch).toHaveBeenCalledTimes(2);
    await harness.dispose();
  });

  it("lets an interaction win an idle race before synthesis starts", async () => {
    const harness = createHarness();
    await beginUpload(harness);
    await waitForPhase(harness, "working");
    harness.setThreadStatus("idle");
    harness.setInteractions([
      {
        status: "pending",
        turnId: "turn-voice",
        payload: { kind: "approval" },
      },
    ]);

    harness.emit("thread.idle", { thread: { id: owner.threadId } });
    harness.changeThread(["interactions-changed"]);

    await waitForPhase(harness, "ready");
    expect(fetch).toHaveBeenCalledTimes(1);
    await harness.dispose();
  });

  it("reconciles terminal state after an idle race and on reconnect", async () => {
    const idleHarness = createHarness();
    idleHarness.setOnSend(() => idleHarness.setThreadStatus("idle"));
    await beginUpload(idleHarness);
    await waitForPhase(idleHarness, "speaking");
    await idleHarness.dispose();

    vi.mocked(fetch).mockClear();
    const reconnectHarness = createHarness();
    await beginUpload(reconnectHarness);
    await vi.waitFor(() =>
      expect(reconnectHarness.threadGetCalls).toBeGreaterThanOrEqual(2),
    );
    reconnectHarness.setThreadStatus("idle");
    reconnectHarness.reconnect();
    await waitForPhase(reconnectHarness, "speaking");
    expect(fetch).toHaveBeenCalledTimes(2);
    await reconnectHarness.dispose();
  });

  it("truncates long answers before requesting speech", async () => {
    const harness = createHarness();
    harness.setEvents(voiceRows({
      answer: `${"sentence ".repeat(870)}Done. ${"overflow ".repeat(200)}`,
    }));
    harness.setOnSend(() => harness.setThreadStatus("idle"));
    await beginUpload(harness);
    await waitForPhase(harness, "speaking");

    const speechCall = vi.mocked(fetch).mock.calls.find(([input]) =>
      String(input).endsWith("/v1/audio/speech"),
    );
    const payload = JSON.parse(String(speechCall?.[1]?.body)) as { input: string };
    expect(payload.input.length).toBeLessThanOrEqual(8_000);
    expect(payload.input).toMatch(/[.!?]$/);
    await harness.dispose();
  });

  it("allows exactly one of two concurrent reservations", async () => {
    const harness = createHarness();
    const [first, second] = await Promise.all([
      harness.api.reserve(owner),
      harness.api.reserve(other),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first.reason, second.reason]).toContain("voice is busy");
    await harness.dispose();
  });

  it("rejects stale and non-owner mutations and hides audio from them", async () => {
    const harness = createHarness();
    const exchangeId = await reserve(harness);
    expect(harness.api.cancel({ ...owner, exchangeId: "stale" })).toEqual({ ok: false });
    expect(harness.api.cancel({ ...other, exchangeId })).toEqual({ ok: false });
    expect((await harness.upload(exchangeId, other.controllerId)).status).toBe(409);

    harness.setOnSend(() => harness.setThreadStatus("idle"));
    expect((await harness.upload(exchangeId)).status).toBe(202);
    const speaking = await waitForPhase(harness, "speaking");
    expect(speaking.chunks).toHaveLength(1);
    expect((await state(harness, other)).chunks).toEqual([]);
    expect((await harness.getAudio("guessed-audio-id")).status).toBe(404);
    expect(harness.api.finishPlayback({
      ...other,
      exchangeId,
      playedThroughIndex: 0,
    })).toEqual({ ok: false });
    await harness.dispose();
  });

  it("expires listening and speaking slots, clearing speaking audio", async () => {
    vi.useFakeTimers();
    const listeningHarness = createHarness();
    await reserve(listeningHarness);
    await vi.advanceTimersByTimeAsync(80_000);
    expect((await state(listeningHarness)).phase).toBe("listening");
    await vi.advanceTimersByTimeAsync(105_000);
    expect((await state(listeningHarness)).phase).toBe("ready");
    await listeningHarness.dispose();

    const speakingHarness = createHarness();
    speakingHarness.setOnSend(() => speakingHarness.setThreadStatus("idle"));
    await beginUpload(speakingHarness);
    const speaking = await waitForPhase(speakingHarness, "speaking");
    const audioId = speaking.chunks[0]?.id;
    if (!audioId) throw new Error("speaking state has no chunk id");
    expect((await speakingHarness.getAudio(audioId)).status).toBe(200);

    await vi.advanceTimersByTimeAsync(8 * 60_000 + 5_000);
    expect((await state(speakingHarness)).phase).toBe("speaking");
    expect((await speakingHarness.getAudio(audioId)).status).toBe(200);

    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect((await state(speakingHarness)).phase).toBe("ready");
    expect((await speakingHarness.getAudio(audioId)).status).toBe(404);
    await speakingHarness.dispose();
  });

  it("finishPlayback releases the slot and invalidates the chunk id", async () => {
    const harness = createHarness();
    harness.setOnSend(() => harness.setThreadStatus("idle"));
    const exchangeId = await beginUpload(harness);
    const speaking = await waitForPhase(harness, "speaking");
    const audioId = speaking.chunks[0]?.id;
    if (!audioId) throw new Error("speaking state has no chunk id");

    expect(harness.api.finishPlayback({
      ...owner,
      exchangeId,
      playedThroughIndex: speaking.chunks[0]!.index,
    })).toEqual({ ok: true });
    expect((await state(harness)).phase).toBe("ready");
    expect((await harness.getAudio(audioId)).status).toBe(404);
    await harness.dispose();
  });

  it("stashes one fetchable WAV per sentence while the turn is still active", async () => {
    const harness = createHarness();
    harness.setEvents([
      row(11, "client/turn/requested", threadScope, {
        requestId: "request-voice",
        initiator: "user",
        input: [{ type: "text", text: "voice transcript" }],
      }),
      row(12, "turn/input/accepted", turnScope, {
        clientRequestId: "request-voice",
      }),
      row(13, "item/started", turnScope, {
        item: { type: "agentMessage", id: "live-answer", text: "" },
      }),
      row(14, "item/agentMessage/delta", turnScope, {
        itemId: "live-answer",
        delta: "First sentence. Second sentence.",
      }),
    ]);

    const exchangeId = await beginUpload(harness);
    const speaking = await vi.waitFor(async () => {
      const next = await state(harness);
      expect(next.chunks).toHaveLength(2);
      return next;
    });

    expect(speaking.phase).toBe("speaking");
    expect(speaking.streamComplete).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const chunk of speaking.chunks) {
      expect((await harness.getAudio(chunk.id)).status).toBe(200);
    }
    expect(exchangeId).toBeTruthy();
    await harness.dispose();
  });

  it("keeps duplicate event pings and overlapping reads from duplicating TTS", async () => {
    let resolveEvents!: (rows: VoiceEventRow[]) => void;
    const pending = new Promise<VoiceEventRow[]>((resolve) => {
      resolveEvents = resolve;
    });
    const harness = createHarness();
    harness.setEventLoader(() => pending);
    await beginUpload(harness);
    await vi.waitFor(() => expect(harness.eventListCalls).toEqual(["10"]));

    harness.changeThread(["events-appended"], ["item/agentMessage/delta"]);
    harness.changeThread(["events-appended"], ["item/agentMessage/delta"]);
    expect(harness.eventListCalls).toEqual(["10"]);

    resolveEvents([
      row(11, "client/turn/requested", threadScope, {
        requestId: "request-voice",
        initiator: "user",
        input: [{ type: "text", text: "voice transcript" }],
      }),
      row(12, "turn/input/accepted", turnScope, {
        clientRequestId: "request-voice",
      }),
      row(13, "item/started", turnScope, {
        item: { type: "agentMessage", id: "answer", text: "" },
      }),
      row(14, "item/agentMessage/delta", turnScope, {
        itemId: "answer",
        delta: "Only once.",
      }),
    ]);

    await vi.waitFor(async () => expect((await state(harness)).chunks).toHaveLength(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    await harness.dispose();
  });

  it("drains a full terminal page before reconciling the final answer", async () => {
    const firstPage: VoiceEventRow[] = [
      row(11, "client/turn/requested", threadScope, {
        requestId: "request-voice",
        initiator: "user",
        input: [{ type: "text", text: "voice transcript" }],
      }),
      row(12, "turn/input/accepted", turnScope, {
        clientRequestId: "request-voice",
      }),
      ...Array.from({ length: 97 }, (_, index) =>
        row(13 + index, "test/noop", threadScope, {}),
      ),
      row(110, "turn/completed", turnScope, { status: "completed" }),
    ];
    const secondPage = [
      row(111, "item/completed", turnScope, {
        item: { type: "agentMessage", id: "final-answer", text: "Final answer." },
      }),
    ];
    const harness = createHarness();
    harness.setEventLoader((afterSeq) =>
      Promise.resolve(afterSeq === "10" ? firstPage : secondPage),
    );

    await beginUpload(harness);
    const speaking = await waitForPhase(harness, "speaking");

    expect(harness.eventListCalls).toEqual(["10", "110"]);
    expect(speaking.chunks).toHaveLength(1);
    expect(speaking.streamComplete).toBe(true);
    await harness.dispose();
  });

  it("aborts stale epoch synthesis and streams the next assistant item", async () => {
    let speechCalls = 0;
    let firstSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/audio/transcriptions")) return jsonResponse({ text: "voice transcript" });
      if (!url.endsWith("/v1/audio/speech")) throw new Error(`unexpected fetch ${url}`);
      speechCalls += 1;
      if (speechCalls === 1) {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          firstSignal?.addEventListener("abort", () => reject(firstSignal?.reason), { once: true });
        });
      }
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "content-type": "audio/wav" },
      });
    });

    const harness = createHarness();
    harness.setEvents([
      row(11, "client/turn/requested", threadScope, {
        requestId: "request-voice",
        initiator: "user",
        input: [{ type: "text", text: "voice transcript" }],
      }),
      row(12, "turn/input/accepted", turnScope, { clientRequestId: "request-voice" }),
      row(13, "item/started", turnScope, {
        item: { type: "agentMessage", id: "first", text: "" },
      }),
      row(14, "item/agentMessage/delta", turnScope, {
        itemId: "first",
        delta: "Old sentence.",
      }),
    ]);
    await beginUpload(harness);
    await vi.waitFor(() => expect(speechCalls).toBe(1));

    harness.setEvents([
      row(11, "client/turn/requested", threadScope, {
        requestId: "request-voice",
        initiator: "user",
        input: [{ type: "text", text: "voice transcript" }],
      }),
      row(12, "turn/input/accepted", turnScope, { clientRequestId: "request-voice" }),
      row(13, "item/started", turnScope, {
        item: { type: "agentMessage", id: "first", text: "" },
      }),
      row(14, "item/agentMessage/delta", turnScope, {
        itemId: "first",
        delta: "Old sentence.",
      }),
      row(15, "item/started", turnScope, {
        item: { type: "commandExecution", id: "tool-1", command: "pwd" },
      }),
      row(16, "item/started", turnScope, {
        item: { type: "agentMessage", id: "second", text: "" },
      }),
      row(17, "item/agentMessage/delta", turnScope, {
        itemId: "second",
        delta: "New sentence.",
      }),
    ]);
    harness.changeThread(["events-appended"], ["item/started", "item/agentMessage/delta"]);

    await vi.waitFor(async () => {
      const next = await state(harness);
      expect(next.chunks).toHaveLength(1);
      expect(next.error).toBeNull();
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(speechCalls).toBe(2);
    await harness.dispose();
  });

  it("acknowledges exact chunks, keeps their audio fetchable, and rejects stale acks", async () => {
    const harness = createHarness();
    harness.setOnSend(() => harness.setThreadStatus("idle"));
    const exchangeId = await beginUpload(harness);
    const speaking = await waitForPhase(harness, "speaking");
    const chunk = speaking.chunks[0]!;

    expect(harness.api.ackPlayback({ ...owner, exchangeId, playedThroughIndex: chunk.index })).toEqual({ ok: true });
    expect((await state(harness)).chunks).toEqual([]);
    expect((await harness.getAudio(chunk.id)).status).toBe(200);
    expect(harness.api.ackPlayback({ ...owner, exchangeId, playedThroughIndex: chunk.index })).toEqual({ ok: false });
    expect(harness.api.finishPlayback({ ...owner, exchangeId, playedThroughIndex: chunk.index })).toEqual({ ok: true });
    expect((await state(harness)).phase).toBe("ready");
    await harness.dispose();
  });

  it("treats a stash over 64 MB as a post-send exchange failure", async () => {
    const huge = new Uint8Array(64 * 1024 * 1024 + 1);
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/audio/transcriptions")) return jsonResponse({ text: "voice transcript" });
      if (url.endsWith("/v1/audio/speech")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => huge.buffer,
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const harness = createHarness();
    harness.setOnSend(() => harness.setThreadStatus("idle"));
    await beginUpload(harness);

    const failed = await waitForPhase(harness, "failed");
    expect(failed.error).toContain("64 MB");
    expect(harness.sends).toHaveLength(1);
    await harness.dispose();
  });
});
