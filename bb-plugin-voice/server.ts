import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  findTurnAnswer,
  findVoiceRequestId,
  loadEventsAfter,
  type VoiceEventRow,
} from "./lib/correlation";
import { mdToSpeakable, truncateSpeakable } from "./lib/speakable";

const DEFAULT_SPEECH_SERVICE_URL = "http://100.81.193.12:18077";
const LISTENING_TTL_MS = 3 * 60_000;
const SPEAKING_TTL_MS = 15 * 60_000;
const TTS_MAX_INPUT_CHARS = 8_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

type Phase = "listening" | "working" | "speaking" | "failed";
type Stage =
  | "transcribing"
  | "sending"
  | "waiting"
  | "resolving"
  | "synthesizing"
  | null;
type TerminalSignal =
  | { kind: "idle" }
  | { kind: "failed"; error: string };

interface Exchange {
  exchangeId: string;
  controllerId: string;
  threadId: string;
  phase: Phase;
  stage: Stage;
  baselineSeq: string | null;
  requestId: string | null;
  terminalSignal: TerminalSignal | null;
  reconcileAgain: boolean;
  audio: Buffer | null;
  audioId: string | null;
  error: string | null;
  expiresAt: number;
}

const identitySchema = z.object({
  threadId: z.string().min(1),
  controllerId: z.string().min(1),
}).strict();

const mutationSchema = identitySchema.extend({
  exchangeId: z.string().min(1),
}).strict();

export const rpcContract = defineRpcContract({
  getState: {
    input: identitySchema,
    output: z.object({
      phase: z.enum(["ready", "listening", "working", "speaking", "failed"]),
      canControl: z.boolean(),
      exchangeId: z.string().nullable(),
      audioId: z.string().nullable(),
      error: z.string().nullable(),
    }).strict(),
  },
  reserve: {
    input: identitySchema,
    output: z.object({
      ok: z.boolean(),
      exchangeId: z.string().optional(),
      reason: z.string().optional(),
    }).strict(),
  },
  cancel: {
    input: mutationSchema,
    output: z.object({ ok: z.boolean() }).strict(),
  },
  finishPlayback: {
    input: mutationSchema,
    output: z.object({ ok: z.boolean() }).strict(),
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimServiceUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function recordingName(mimeType: string): string {
  if (mimeType.includes("webm")) return "recording.webm";
  if (mimeType.includes("mp4")) return "recording.mp4";
  if (mimeType.includes("ogg")) return "recording.ogg";
  if (mimeType.includes("wav")) return "recording.wav";
  return "recording.audio";
}

async function readAudioBody(request: Request): Promise<Buffer> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
    throw new Error("audio exceeds the 25 MB limit");
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw new Error("audio exceeds the 25 MB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("speech service request timed out")),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}

export default function voicePlugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    speechServiceUrl: {
      type: "string",
      label: "Speech service URL",
      default: DEFAULT_SPEECH_SERVICE_URL,
    },
  });

  let active: Exchange | null = null;
  let reservationTail = Promise.resolve();
  const abortControllers = new Map<string, AbortController>();
  const serviceUrls = new Map<string, string>();

  const publishChanged = (threadId: string) => {
    bb.realtime.publish("voice:changed", { threadId });
  };

  const owns = (input: {
    threadId: string;
    controllerId: string;
    exchangeId: string;
  }): boolean =>
    active?.threadId === input.threadId &&
    active.controllerId === input.controllerId &&
    active.exchangeId === input.exchangeId;

  const release = (exchangeId: string): boolean => {
    if (active?.exchangeId !== exchangeId) return false;
    const threadId = active.threadId;
    abortControllers.get(exchangeId)?.abort();
    abortControllers.delete(exchangeId);
    serviceUrls.delete(exchangeId);
    active.audio = null;
    active.audioId = null;
    active = null;
    publishChanged(threadId);
    return true;
  };

  const fail = (exchangeId: string, message: string): void => {
    if (active?.exchangeId !== exchangeId) return;
    abortControllers.get(exchangeId)?.abort();
    abortControllers.delete(exchangeId);
    serviceUrls.delete(exchangeId);
    active.phase = "failed";
    active.stage = null;
    active.audio = null;
    active.audioId = null;
    active.error = message;
    active.expiresAt = Number.MAX_SAFE_INTEGER;
    publishChanged(active.threadId);
  };

  const runForExchange = (
    exchangeId: string,
    operation: () => Promise<void>,
  ): void => {
    void operation().catch((error) => {
      if (active?.exchangeId === exchangeId) {
        fail(exchangeId, errorMessage(error));
      }
    });
  };

  const loadEvents = (exchange: Exchange): Promise<VoiceEventRow[]> => {
    if (exchange.baselineSeq === null) {
      throw new Error("voice exchange has no event baseline");
    }
    const signal = abortControllers.get(exchange.exchangeId)?.signal;
    return loadEventsAfter(exchange.baselineSeq, (afterSeq, limit) =>
      bb.sdk.threads.events.list({
        threadId: exchange.threadId,
        afterSeq,
        limit,
        signal,
      }),
    );
  };

  const pendingProviderInteraction = async (
    exchange: Exchange,
  ): Promise<boolean> => {
    const interactions = await bb.sdk.threads.interactions.list({
      threadId: exchange.threadId,
      signal: abortControllers.get(exchange.exchangeId)?.signal,
    });
    return interactions.some((interaction) => interaction.status === "pending");
  };

  const rememberTerminal = (
    exchange: Exchange,
    signal: TerminalSignal,
  ): void => {
    if (exchange.terminalSignal?.kind === "failed") return;
    exchange.terminalSignal = signal;
  };

  const takeTerminal = (exchange: Exchange): TerminalSignal | null => {
    const signal = exchange.terminalSignal;
    exchange.terminalSignal = null;
    return signal;
  };

  const synthesize = async (
    exchangeId: string,
    text: string,
  ): Promise<void> => {
    const exchange = active;
    if (
      exchange?.exchangeId !== exchangeId ||
      exchange.stage !== "synthesizing"
    ) {
      return;
    }
    const url = serviceUrls.get(exchangeId);
    const controller = abortControllers.get(exchangeId);
    if (!url || !controller) throw new Error("voice exchange resources expired");

    const response = await fetchWithTimeout(
      `${url}/v1/audio/speech`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: text, voice: "Aiden" }),
      },
      controller.signal,
      180_000,
    );
    if (!response.ok) {
      throw new Error(`speech synthesis failed (HTTP ${response.status})`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (active?.exchangeId !== exchangeId || active.stage !== "synthesizing") {
      return;
    }
    if (audio.byteLength === 0) throw new Error("speech synthesis returned no audio");

    active.audio = audio;
    active.audioId = randomUUID();
    active.phase = "speaking";
    active.stage = null;
    active.error = null;
    active.expiresAt = Date.now() + SPEAKING_TTL_MS;
    abortControllers.delete(exchangeId);
    serviceUrls.delete(exchangeId);
    publishChanged(active.threadId);
  };

  const completeExchange = async (exchangeId: string): Promise<void> => {
    const exchange = active;
    if (exchange?.exchangeId !== exchangeId || exchange.stage !== "resolving") {
      return;
    }
    if (!exchange.requestId) throw new Error("voice request was not resolved");

    const rows = await loadEvents(exchange);
    if (active?.exchangeId !== exchangeId || active.stage !== "resolving") {
      return;
    }
    const answer = findTurnAnswer(rows, exchange.requestId);
    if (active.terminalSignal?.kind === "failed") {
      fail(exchangeId, active.terminalSignal.error);
      return;
    }
    if (!answer?.text) {
      release(exchangeId);
      return;
    }

    const speakable = truncateSpeakable(
      mdToSpeakable(answer.text),
      TTS_MAX_INPUT_CHARS,
    );
    if (!speakable) {
      release(exchangeId);
      return;
    }
    active.stage = "synthesizing";
    await synthesize(exchangeId, speakable);
  };

  const reconcileTerminal = async (exchangeId: string): Promise<void> => {
    const exchange = active;
    if (
      exchange?.exchangeId !== exchangeId ||
      exchange.stage !== "waiting" ||
      !exchange.requestId
    ) {
      return;
    }
    exchange.stage = "resolving";
    exchange.reconcileAgain = false;

    const hasPendingInteraction = await pendingProviderInteraction(exchange);
    if (active?.exchangeId !== exchangeId || active.stage !== "resolving") {
      return;
    }
    if (active.terminalSignal?.kind === "failed") {
      fail(exchangeId, active.terminalSignal.error);
      return;
    }
    if (hasPendingInteraction) {
      release(exchangeId);
      return;
    }

    const thread = await bb.sdk.threads.get({
      threadId: exchange.threadId,
      signal: abortControllers.get(exchangeId)?.signal,
    });
    if (active?.exchangeId !== exchangeId || active.stage !== "resolving") {
      return;
    }
    const terminalSignal = takeTerminal(active);
    if (terminalSignal?.kind === "failed") {
      fail(exchangeId, terminalSignal.error);
    } else if (thread.status === "error") {
      fail(exchangeId, "thread turn failed");
    } else if (terminalSignal?.kind === "idle" || thread.status === "idle") {
      await completeExchange(exchangeId);
    } else {
      active.stage = "waiting";
      if (active.reconcileAgain) {
        await reconcileTerminal(exchangeId);
      }
    }
  };

  const processUpload = async (
    exchangeId: string,
    mimeType: string,
    audio: Buffer,
  ): Promise<void> => {
    const exchange = active;
    if (
      exchange?.exchangeId !== exchangeId ||
      exchange.stage !== "transcribing"
    ) {
      return;
    }
    const { speechServiceUrl } = await settings.get();
    if (active?.exchangeId !== exchangeId || active.stage !== "transcribing") {
      return;
    }
    const url = trimServiceUrl(speechServiceUrl);
    if (!url) throw new Error("speech service URL is empty");
    serviceUrls.set(exchangeId, url);

    const controller = new AbortController();
    abortControllers.set(exchangeId, controller);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(audio)], { type: mimeType }),
      recordingName(mimeType),
    );
    const response = await fetchWithTimeout(
      `${url}/v1/audio/transcriptions`,
      { method: "POST", body: form },
      controller.signal,
      60_000,
    );
    if (!response.ok) {
      throw new Error(`transcription failed (HTTP ${response.status})`);
    }
    const payload: unknown = await response.json();
    if (active?.exchangeId !== exchangeId || active.stage !== "transcribing") {
      return;
    }
    const transcript =
      payload &&
      typeof payload === "object" &&
      "text" in payload &&
      typeof (payload as { text: unknown }).text === "string"
        ? (payload as { text: string }).text
        : "";
    if (!transcript.trim()) {
      fail(exchangeId, "nothing transcribed");
      return;
    }
    const timeline = await bb.sdk.threads.timeline({
      threadId: exchange.threadId,
      summaryOnly: "true",
      signal: controller.signal,
    });
    if (active?.exchangeId !== exchangeId || active.stage !== "transcribing") {
      return;
    }
    active.baselineSeq = String(timeline.maxSeq);
    active.stage = "sending";

    await bb.sdk.threads.send({
      threadId: exchange.threadId,
      mode: "start",
      input: [{ type: "text", text: transcript, mentions: [] }],
    });
    if (active?.exchangeId !== exchangeId || active.stage !== "sending") {
      return;
    }

    const rows = await loadEvents(active);
    if (active?.exchangeId !== exchangeId || active.stage !== "sending") {
      return;
    }
    const requestId = findVoiceRequestId(rows, transcript);
    if (!requestId) {
      fail(exchangeId, "sent voice message could not be found");
      return;
    }
    active.requestId = requestId;
    active.stage = "waiting";
    await reconcileTerminal(exchangeId);
  };

  const reserve = async (input: {
    threadId: string;
    controllerId: string;
  }): Promise<{ ok: boolean; exchangeId?: string; reason?: string }> => {
    let unlock = () => {};
    const previous = reservationTail;
    reservationTail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      const replaceableId = active?.phase === "failed" ? active.exchangeId : null;
      if (active && !replaceableId) return { ok: false, reason: "voice is busy" };

      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      if (active && active.exchangeId !== replaceableId) {
        return { ok: false, reason: "voice is busy" };
      }
      if (thread.status !== "idle") {
        return { ok: false, reason: "thread is busy" };
      }
      const interactions = await bb.sdk.threads.interactions.list({
        threadId: input.threadId,
      });
      if (active && active.exchangeId !== replaceableId) {
        return { ok: false, reason: "voice is busy" };
      }
      if (interactions.some((interaction) => interaction.status === "pending")) {
        return { ok: false, reason: "thread needs input" };
      }

      if (replaceableId) {
        abortControllers.get(replaceableId)?.abort();
        abortControllers.delete(replaceableId);
        serviceUrls.delete(replaceableId);
      }
      const exchangeId = randomUUID();
      active = {
        exchangeId,
        controllerId: input.controllerId,
        threadId: input.threadId,
        phase: "listening",
        stage: null,
        baselineSeq: null,
        requestId: null,
        terminalSignal: null,
        reconcileAgain: false,
        audio: null,
        audioId: null,
        error: null,
        expiresAt: Date.now() + LISTENING_TTL_MS,
      };
      publishChanged(input.threadId);
      return { ok: true, exchangeId };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    } finally {
      unlock();
    }
  };

  bb.rpc.register(rpcContract, {
    getState(input) {
      const exchange = active;
      if (!exchange || exchange.threadId !== input.threadId) {
        return {
          phase: "ready" as const,
          canControl: false,
          exchangeId: null,
          audioId: null,
          error: null,
        };
      }
      const canControl = exchange.controllerId === input.controllerId;
      return {
        phase: exchange.phase,
        canControl,
        exchangeId: exchange.exchangeId,
        audioId: canControl ? exchange.audioId : null,
        error: exchange.error,
      };
    },
    reserve,
    cancel(input) {
      return { ok: owns(input) && release(input.exchangeId) };
    },
    finishPlayback(input) {
      if (!owns(input) || active?.phase !== "speaking") return { ok: false };
      return { ok: release(input.exchangeId) };
    },
  });

  bb.http.route(
    "POST",
    "/audio",
    async (context) => {
      const exchangeId = context.req.query("exchangeId")?.trim() ?? "";
      const controllerId = context.req.query("controllerId")?.trim() ?? "";
      const mimeType = context.req.query("mimeType")?.trim() ?? "";
      const exchange = active;
      if (!exchangeId || !controllerId || !mimeType) {
        return context.json({ error: "exchangeId, controllerId, and mimeType are required" }, 400);
      }
      if (
        !exchange ||
        exchange.exchangeId !== exchangeId ||
        exchange.controllerId !== controllerId
      ) {
        return context.json({ error: "voice exchange is not owned by this controller" }, 409);
      }
      if (exchange.phase !== "listening") {
        return context.json({ error: "voice exchange is not listening" }, 409);
      }
      exchange.phase = "working";
      exchange.stage = "transcribing";
      exchange.expiresAt = Number.MAX_SAFE_INTEGER;
      publishChanged(exchange.threadId);

      try {
        const body = await readAudioBody(context.req.raw);
        if (active?.exchangeId !== exchangeId || active.stage !== "transcribing") {
          return context.json({ error: "voice exchange ended during upload" }, 409);
        }
        runForExchange(exchangeId, () => processUpload(exchangeId, mimeType, body));
        return context.json({ ok: true, sizeBytes: body.byteLength }, 202);
      } catch (error) {
        fail(exchangeId, errorMessage(error));
        const status = errorMessage(error).includes("25 MB") ? 413 : 400;
        return context.json({ error: errorMessage(error) }, status);
      }
    },
    { auth: "token" },
  );

  bb.http.route("GET", "/audio", (context) => {
    const audioId = context.req.query("id")?.trim();
    if (
      !audioId ||
      active?.phase !== "speaking" ||
      active.audioId !== audioId ||
      !active.audio
    ) {
      return context.json({ error: "audio not found" }, 404);
    }
    return new Response(new Uint8Array(active.audio), {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(active.audio.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  bb.events.on("thread.idle", ({ thread }) => {
    const exchange = active;
    if (
      exchange?.threadId !== thread.id ||
      (exchange.stage !== "waiting" && exchange.stage !== "resolving") ||
      !exchange.requestId
    ) {
      return;
    }
    rememberTerminal(exchange, { kind: "idle" });
    if (exchange.stage === "resolving") return;
    runForExchange(exchange.exchangeId, () =>
      reconcileTerminal(exchange.exchangeId),
    );
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const exchange = active;
    if (
      exchange?.threadId !== thread.id ||
      (exchange.stage !== "waiting" && exchange.stage !== "resolving") ||
      !exchange.requestId
    ) {
      return;
    }
    if (exchange.stage === "resolving") {
      rememberTerminal(exchange, {
        kind: "failed",
        error: error || "thread turn failed",
      });
      return;
    }
    fail(exchange.exchangeId, error || "thread turn failed");
  });

  const unsubscribeThreadChanges = bb.sdk.subscribe({
    event: "thread:changed",
    callback(event) {
      const exchange = active;
      if (
        (exchange?.stage !== "waiting" && exchange?.stage !== "resolving") ||
        !exchange.requestId ||
        event.id !== exchange.threadId ||
        !event.changes.includes("interactions-changed")
      ) {
        return;
      }
      if (exchange.stage === "resolving") {
        exchange.reconcileAgain = true;
        return;
      }
      runForExchange(exchange.exchangeId, () =>
        reconcileTerminal(exchange.exchangeId),
      );
    },
  });

  const unsubscribeReconnect = bb.sdk.subscribe({
    event: "realtime:connection",
    callback(event) {
      const exchange = active;
      if (
        event.state !== "connected" ||
        !event.reconnected ||
        (exchange?.stage !== "waiting" && exchange?.stage !== "resolving") ||
        !exchange.requestId
      ) {
        return;
      }
      if (exchange.stage === "resolving") {
        exchange.reconcileAgain = true;
        return;
      }
      runForExchange(exchange.exchangeId, () =>
        reconcileTerminal(exchange.exchangeId),
      );
    },
  });

  const expirySweep = setInterval(() => {
    const exchange = active;
    if (
      exchange &&
      (exchange.phase === "listening" || exchange.phase === "speaking") &&
      exchange.expiresAt <= Date.now()
    ) {
      release(exchange.exchangeId);
    }
  }, 5_000);

  bb.onDispose(() => {
    clearInterval(expirySweep);
    unsubscribeReconnect();
    unsubscribeThreadChanges();
    for (const controller of abortControllers.values()) controller.abort();
    abortControllers.clear();
    serviceUrls.clear();
    if (active) {
      const threadId = active.threadId;
      active.audio = null;
      active.audioId = null;
      active = null;
      publishChanged(threadId);
    }
  });
}
