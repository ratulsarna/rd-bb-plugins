import { randomUUID } from "node:crypto";
import {
  defineRpcContract,
  type BbPluginApi,
} from "@bb/plugin-sdk";
import { z } from "zod";
import {
  findTurnAnswer,
  findVoiceRequestId,
  type VoiceEventRow,
} from "./lib/correlation";
import {
  initialStreamState,
  processEvents,
  type StreamState,
} from "./lib/stream-follower";
import { SentenceAssembler, type Sentence } from "./lib/sentencer";
import { truncateSpeakable } from "./lib/speakable";

const DEFAULT_SPEECH_SERVICE_URL = "http://127.0.0.1:18077";
const LISTENING_TTL_MS = 3 * 60_000;
const SPEAKING_TTL_MS = 15 * 60_000;
const TTS_MAX_INPUT_CHARS = 8_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_STASH_BYTES = 64 * 1024 * 1024;

type Phase = "listening" | "working" | "speaking" | "failed";
type Stage =
  | "transcribing"
  | "sending"
  | "waiting"
  | "resolving"
  | null;
type TerminalSignal =
  | { kind: "idle" }
  | { kind: "failed"; error: string };
type ChunkState = "queued" | "synthesizing" | "stashed" | "played";

export interface ChunkLedgerEntry {
  audio: Buffer | null;
  audioId: string;
  epoch: number;
  index: number;
  itemId: string;
  speakable: string;
  span: { rawStart: number; rawEnd: number };
  state: ChunkState;
}

interface TtsJob {
  controller: AbortController;
  epoch: number;
  index: number;
  itemId: string;
  unlink: () => void;
}

interface Exchange {
  exchangeId: string;
  controllerId: string;
  threadId: string;
  phase: Phase;
  stage: Stage;
  baselineSeq: string | null;
  requestId: string | null;
  transcript: string | null;
  stream: StreamState;
  eventRows: VoiceEventRow[];
  eventSeqs: Set<number>;
  terminalSignal: TerminalSignal | null;
  reconcileAgain: boolean;
  reconcilePrepared: boolean;
  streamComplete: boolean;
  ledger: Map<number, ChunkLedgerEntry>;
  queuedIndexes: number[];
  nextChunkIndex: number;
  ttsJob: TtsJob | null;
  audioBytes: number;
  lastAckIndex: number;
  error: string | null;
  expiresAt: number;
  pumpRunning: boolean;
  pumpAgain: boolean;
}

const identitySchema = z.object({
  threadId: z.string().min(1),
  controllerId: z.string().min(1),
}).strict();

const mutationSchema = identitySchema.extend({
  exchangeId: z.string().min(1),
}).strict();

const playbackMutationSchema = mutationSchema.extend({
  playedThroughIndex: z.number().int().nonnegative(),
}).strict();

const runtimeRpcContract = defineRpcContract({
  getState: {
    input: identitySchema,
    output: z.object({
      phase: z.enum(["ready", "listening", "working", "speaking", "failed"]),
      exchangeId: z.string().nullable(),
      error: z.string().nullable(),
      canControl: z.boolean(),
      chunks: z.array(z.object({
        id: z.string(),
        index: z.number().int().nonnegative(),
      }).strict()),
      streamComplete: z.boolean(),
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
  ackPlayback: {
    input: playbackMutationSchema,
    output: z.object({ ok: z.boolean() }).strict(),
  },
  cancel: {
    input: mutationSchema,
    output: z.object({ ok: z.boolean() }).strict(),
  },
  finishPlayback: {
    input: playbackMutationSchema,
    output: z.object({ ok: z.boolean() }).strict(),
  },
});

export const rpcContract = runtimeRpcContract;

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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function eventError(row: VoiceEventRow): string | null {
  const data = record(row.data);
  const error = record(data?.error);
  return typeof error?.message === "string" ? error.message : null;
}

function turnStatus(row: VoiceEventRow): string | null {
  return typeof record(row.data)?.status === "string"
    ? String(record(row.data)?.status)
    : null;
}

function sentenceFromOffset(
  text: string,
  rawOffset: number,
): Sentence[] {
  if (rawOffset >= text.length) return [];
  const assembler = new SentenceAssembler();
  const suffix = text.slice(rawOffset);
  const sentences = [...assembler.push(suffix), ...assembler.flushTail()];
  return sentences.map((sentence) => ({
    ...sentence,
    rawStart: sentence.rawStart + rawOffset,
    rawEnd: sentence.rawEnd + rawOffset,
  }));
}

function coveredThrough(
  ledger: Iterable<ChunkLedgerEntry>,
  itemId: string,
  epoch: number,
): number {
  let covered = 0;
  for (const entry of ledger) {
    if (entry.itemId === itemId && entry.epoch === epoch) {
      covered = Math.max(covered, entry.span.rawEnd);
    }
  }
  return covered;
}

function playedThrough(
  ledger: Iterable<ChunkLedgerEntry>,
  itemId: string,
): number {
  let played = 0;
  for (const entry of ledger) {
    if (entry.itemId === itemId && entry.state === "played") {
      played = Math.max(played, entry.span.rawEnd);
    }
  }
  return played;
}

export function deriveReconcileStart(input: {
  ledger: Iterable<ChunkLedgerEntry>;
  finalItemId: string;
  liveItemId: string | null;
  liveEpoch: number;
  invalidated: boolean;
}): number {
  if (!input.invalidated && input.liveItemId === input.finalItemId) {
    return coveredThrough(input.ledger, input.finalItemId, input.liveEpoch);
  }
  return playedThrough(input.ledger, input.finalItemId);
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
  const exchangeControllers = new Map<string, AbortController>();
  const serviceUrls = new Map<string, string>();

  const updatePhase = (exchange: Exchange): void => {
    if (exchange.phase === "listening" || exchange.phase === "failed") return;
    const hasUnplayedAudio = [...exchange.ledger.values()].some(
      (entry) => entry.state === "stashed",
    );
    exchange.phase = hasUnplayedAudio || exchange.streamComplete
      ? "speaking"
      : "working";
  };

  const publishChanged = (threadId: string): void => {
    if (active?.threadId === threadId) updatePhase(active);
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

  const clearExchangeResources = (exchange: Exchange): void => {
    const controller = exchangeControllers.get(exchange.exchangeId);
    controller?.abort();
    exchangeControllers.delete(exchange.exchangeId);
    if (exchange.ttsJob) {
      exchange.ttsJob.controller.abort();
      exchange.ttsJob.unlink();
      exchange.ttsJob = null;
    }
    exchange.queuedIndexes = [];
    exchange.ledger.clear();
    exchange.audioBytes = 0;
    serviceUrls.delete(exchange.exchangeId);
  };

  const release = (exchangeId: string): boolean => {
    if (active?.exchangeId !== exchangeId) return false;
    const threadId = active.threadId;
    clearExchangeResources(active);
    active = null;
    publishChanged(threadId);
    return true;
  };

  const fail = (exchangeId: string, message: string): void => {
    if (active?.exchangeId !== exchangeId || active.phase === "failed") return;
    const exchange = active;
    clearExchangeResources(exchange);
    exchange.phase = "failed";
    exchange.stage = null;
    exchange.streamComplete = false;
    exchange.error = message;
    exchange.expiresAt = Number.MAX_SAFE_INTEGER;
    publishChanged(exchange.threadId);
  };

  const runForExchange = (
    exchangeId: string,
    operation: () => Promise<void>,
  ): void => {
    void operation().catch((error) => {
      if (active?.exchangeId === exchangeId && active.phase !== "failed") {
        fail(exchangeId, errorMessage(error));
      }
    });
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

  const currentController = (exchange: Exchange): AbortController | null =>
    exchangeControllers.get(exchange.exchangeId) ?? null;

  const isCurrentTts = (
    exchange: Exchange,
    job: TtsJob,
    entry: ChunkLedgerEntry,
  ): boolean =>
    active?.exchangeId === exchange.exchangeId &&
    exchange.ttsJob?.index === job.index &&
    exchange.ledger.get(job.index) === entry &&
    entry.state === "synthesizing" &&
    entry.epoch === job.epoch &&
    entry.itemId === job.itemId &&
    exchange.stream.epoch === job.epoch &&
    (exchange.stream.speakingItemId === job.itemId || exchange.reconcilePrepared);

  const maybeCompleteStream = (exchange: Exchange): void => {
    if (!exchange.reconcilePrepared || exchange.streamComplete) return;
    if (exchange.ttsJob) return;
    if ([...exchange.ledger.values()].some(
      (entry) => entry.state === "queued" || entry.state === "synthesizing",
    )) return;
    exchange.streamComplete = true;
    exchange.expiresAt = Date.now() + SPEAKING_TTL_MS;
    publishChanged(exchange.threadId);
  };

  const startNextTts = (exchangeId: string): void => {
    const exchange = active;
    if (
      !exchange ||
      exchange.exchangeId !== exchangeId ||
      exchange.ttsJob ||
      exchange.phase === "failed"
    ) return;

    while (exchange.queuedIndexes.length > 0) {
      const index = exchange.queuedIndexes.shift()!;
      const entry = exchange.ledger.get(index);
      if (
        !entry ||
        entry.state !== "queued" ||
        entry.epoch !== exchange.stream.epoch ||
        (entry.itemId !== exchange.stream.speakingItemId && !exchange.reconcilePrepared)
      ) {
        if (entry?.state === "queued") exchange.ledger.delete(index);
        continue;
      }

      const serviceUrl = serviceUrls.get(exchangeId);
      const exchangeController = currentController(exchange);
      if (!serviceUrl || !exchangeController) {
        fail(exchangeId, "voice exchange resources expired");
        return;
      }

      entry.state = "synthesizing";
      const controller = new AbortController();
      const abortJob = () => controller.abort(exchangeController.signal.reason);
      if (exchangeController.signal.aborted) abortJob();
      else exchangeController.signal.addEventListener("abort", abortJob, { once: true });
      const job: TtsJob = {
        controller,
        epoch: entry.epoch,
        index: entry.index,
        itemId: entry.itemId,
        unlink: () => exchangeController.signal.removeEventListener("abort", abortJob),
      };
      exchange.ttsJob = job;

      void (async () => {
        try {
          const response = await fetchWithTimeout(
            `${serviceUrl}/v1/audio/speech`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                input: truncateSpeakable(entry.speakable ?? "", TTS_MAX_INPUT_CHARS),
                voice: "Aiden",
              }),
            },
            controller.signal,
            180_000,
          );
          if (!response.ok) {
            throw new Error(`speech synthesis failed (HTTP ${response.status})`);
          }
          const audio = Buffer.from(await response.arrayBuffer());
          if (!isCurrentTts(exchange, job, entry)) return;
          if (audio.byteLength === 0) {
            throw new Error("speech synthesis returned no audio");
          }
          if (exchange.audioBytes + audio.byteLength > MAX_STASH_BYTES) {
            throw new Error("speech audio stash exceeds the 64 MB limit");
          }

          entry.audio = audio;
          entry.state = "stashed";
          exchange.audioBytes += audio.byteLength;
          exchange.expiresAt = Date.now() + SPEAKING_TTL_MS;
          publishChanged(exchange.threadId);
        } catch (error) {
          const stale =
            controller.signal.aborted ||
            !isCurrentTts(exchange, job, entry) ||
            active?.exchangeId !== exchangeId;
          if (!stale) fail(exchangeId, errorMessage(error));
        } finally {
          job.unlink();
          if (exchange.ttsJob?.index === job.index) exchange.ttsJob = null;
          if (active?.exchangeId === exchangeId && exchange.phase !== "failed") {
            maybeCompleteStream(exchange);
            startNextTts(exchangeId);
          }
        }
      })();
      return;
    }

    maybeCompleteStream(exchange);
  };

  const enqueueSentences = (
    exchange: Exchange,
    itemId: string,
    epoch: number,
    sentences: readonly Sentence[],
  ): void => {
    if (exchange.phase === "failed") return;
    for (const sentence of sentences) {
      if (!sentence.speakable || sentence.rawEnd <= sentence.rawStart) continue;
      const index = exchange.nextChunkIndex++;
      exchange.ledger.set(index, {
        audio: null,
        audioId: randomUUID(),
        epoch,
        index,
        itemId,
        speakable: sentence.speakable,
        span: { rawStart: sentence.rawStart, rawEnd: sentence.rawEnd },
        state: "queued",
      });
      exchange.queuedIndexes.push(index);
    }
    startNextTts(exchange.exchangeId);
  };

  const invalidatePriorAudio = (exchange: Exchange): void => {
    const liveEpoch = exchange.stream.epoch;
    const liveItemId = exchange.stream.speakingItemId;
    for (const [index, entry] of exchange.ledger) {
      if (entry.state === "played") continue;
      if (entry.state === "stashed") exchange.audioBytes -= entry.audio?.byteLength ?? 0;
      exchange.ledger.delete(index);
    }
    exchange.queuedIndexes = exchange.queuedIndexes.filter((index) => {
      const entry = exchange.ledger.get(index);
      return Boolean(entry);
    });
    if (
      exchange.ttsJob &&
      (exchange.ttsJob.epoch !== liveEpoch || exchange.ttsJob.itemId !== liveItemId)
    ) {
      exchange.ttsJob.controller.abort(new Error("voice epoch superseded"));
    }
    updatePhase(exchange);
    publishChanged(exchange.threadId);
  };

  const markAck = (exchange: Exchange, index: number): boolean => {
    if (!Number.isInteger(index) || index <= exchange.lastAckIndex) return false;
    const entry = exchange.ledger.get(index);
    if (!entry || entry.state !== "stashed") return false;
    for (const candidate of exchange.ledger.values()) {
      if (candidate.index <= index && candidate.state === "stashed") {
        candidate.state = "played";
      }
    }
    exchange.lastAckIndex = index;
    exchange.expiresAt = Date.now() + SPEAKING_TTL_MS;
    publishChanged(exchange.threadId);
    return true;
  };

  const appendEventRows = (exchange: Exchange, rows: readonly VoiceEventRow[]): VoiceEventRow[] => {
    const fresh: VoiceEventRow[] = [];
    for (const row of rows) {
      if (exchange.eventSeqs.has(row.seq)) continue;
      exchange.eventSeqs.add(row.seq);
      exchange.eventRows.push(row);
      fresh.push(row);
    }
    return fresh;
  };

  const applyEventPage = (exchange: Exchange, rows: readonly VoiceEventRow[]): void => {
    const fresh = appendEventRows(exchange, rows);
    let correlated = false;
    if (exchange.requestId === null && exchange.transcript !== null) {
      const requestId = findVoiceRequestId(exchange.eventRows, exchange.transcript);
      if (requestId) {
        exchange.requestId = requestId;
        correlated = true;
        exchange.stream = {
          ...exchange.stream,
          requestId,
        };
        exchange.stage = "waiting";
      }
    }
    if (exchange.requestId === null) return;

    const result = processEvents(exchange.stream, fresh, exchange.requestId);
    exchange.stream = result.state;
    if (result.invalidatePriorAudio) invalidatePriorAudio(exchange);
    if (result.live) {
      enqueueSentences(
        exchange,
        result.live.itemId,
        result.live.epoch,
        result.live.sentences,
      );
    }
    for (const row of fresh) {
      if (row.type !== "turn/completed") continue;
      const status = turnStatus(row);
      if (status === "failed" || status === "interrupted") {
        rememberTerminal(exchange, {
          kind: "failed",
          error: eventError(row) ?? "thread turn failed",
        });
      } else {
        rememberTerminal(exchange, { kind: "idle" });
      }
    }
    if ((correlated || result.turnCompleted) && exchange.stage === "waiting") {
      requestReconcile(exchange.exchangeId);
    }
  };

  const pumpExchange = async (exchangeId: string): Promise<void> => {
    const exchange = active;
    if (!exchange || exchange.exchangeId !== exchangeId || exchange.baselineSeq === null) return;
    const controller = currentController(exchange);
    if (!controller) return;

    while (
      active?.exchangeId === exchangeId &&
      exchange.baselineSeq !== null &&
      (exchange.stage === "sending" || exchange.stage === "waiting" || exchange.stage === "resolving")
    ) {
      const before = Number(exchange.stream.cursorSeq);
      const page = await bb.sdk.threads.events.list({
        threadId: exchange.threadId,
        afterSeq: exchange.stream.cursorSeq,
        limit: "100",
        signal: controller.signal,
      });
      if (page.length === 0) break;
      applyEventPage(exchange, page);
      const lastSeq = page.reduce(
        (highest, row) => Math.max(highest, row.seq),
        before,
      );
      if (exchange.requestId === null && lastSeq > before) {
        exchange.stream = {
          ...exchange.stream,
          cursorSeq: String(lastSeq),
        };
      }
      if (lastSeq <= before) break;
      if (page.length < 100) break;
    }
    if (
      active?.exchangeId === exchangeId &&
      exchange.requestId === null
    ) {
      fail(exchangeId, "sent voice message could not be found");
      return;
    }
    if (active?.exchangeId === exchangeId && exchange.requestId && exchange.terminalSignal) {
      requestReconcile(exchangeId);
    }
  };

  const wake = (exchangeId: string): void => {
    const exchange = active;
    if (
      !exchange ||
      exchange.exchangeId !== exchangeId ||
      exchange.baselineSeq === null ||
      exchange.stage === "transcribing" ||
      exchange.stage === null
    ) return;
    if (exchange.pumpRunning) {
      exchange.pumpAgain = true;
      return;
    }
    exchange.pumpRunning = true;
    void pumpExchange(exchangeId)
      .catch((error) => {
        if (active?.exchangeId === exchangeId && exchange.phase !== "failed") {
          fail(exchangeId, errorMessage(error));
        }
      })
      .finally(() => {
        const current = active;
        if (!current || current.exchangeId !== exchangeId) return;
        current.pumpRunning = false;
        if (current.pumpAgain) {
          current.pumpAgain = false;
          wake(exchangeId);
        }
        if (
          current.stage === "waiting" &&
          current.requestId !== null &&
          (current.terminalSignal !== null || current.reconcileAgain)
        ) {
          requestReconcile(exchangeId);
        }
      });
  };

  const completeStreaming = async (exchangeId: string): Promise<void> => {
    const exchange = active;
    if (
      !exchange ||
      exchange.exchangeId !== exchangeId ||
      exchange.stage !== "resolving" ||
      !exchange.requestId
    ) return;
    if (exchange.reconcilePrepared) {
      maybeCompleteStream(exchange);
      return;
    }

    const answer = findTurnAnswer(exchange.eventRows, exchange.requestId);
    if (!answer?.text || !answer.itemId) {
      const turnCompleted = answer !== null && exchange.eventRows.some(
        (row) =>
          row.type === "turn/completed" &&
          row.scope.kind === "turn" &&
          row.scope.turnId === answer.turnId,
      );
      if (!turnCompleted) {
        exchange.stage = "waiting";
        return;
      }
      release(exchangeId);
      return;
    }

    exchange.reconcilePrepared = true;
    exchange.stream = answer.turnId === exchange.stream.turnId
      ? exchange.stream
      : { ...exchange.stream, turnId: answer.turnId };
    const invalidated = exchange.stream.invalidatedItemIds?.includes(answer.itemId) ?? false;
    const start = deriveReconcileStart({
      ledger: exchange.ledger.values(),
      finalItemId: answer.itemId,
      liveItemId: exchange.stream.speakingItemId,
      liveEpoch: exchange.stream.epoch,
      invalidated,
    });
    enqueueSentences(
      exchange,
      answer.itemId,
      exchange.stream.epoch,
      sentenceFromOffset(answer.text, Math.min(start, answer.text.length)),
    );
    maybeCompleteStream(exchange);
  };

  const reconcileTerminal = async (exchangeId: string): Promise<void> => {
    const exchange = active;
    if (
      !exchange ||
      exchange.exchangeId !== exchangeId ||
      exchange.stage !== "waiting" ||
      !exchange.requestId
    ) return;
    exchange.stage = "resolving";
    exchange.reconcileAgain = false;

    const interactions = await bb.sdk.threads.interactions.list({
      threadId: exchange.threadId,
      signal: currentController(exchange)?.signal,
    });
    if (active?.exchangeId !== exchangeId || exchange.stage !== "resolving") return;
    if (exchange.terminalSignal?.kind === "failed") {
      fail(exchangeId, exchange.terminalSignal.error);
      return;
    }
    if (interactions.some((interaction) => interaction.status === "pending")) {
      release(exchangeId);
      return;
    }

    const thread = await bb.sdk.threads.get({
      threadId: exchange.threadId,
      signal: currentController(exchange)?.signal,
    });
    if (active?.exchangeId !== exchangeId || exchange.stage !== "resolving") return;
    const terminalSignal = takeTerminal(exchange);
    if (terminalSignal?.kind === "failed") {
      fail(exchangeId, terminalSignal.error);
    } else if (thread.status === "error") {
      fail(exchangeId, "thread turn failed");
    } else if (terminalSignal?.kind === "idle" || thread.status === "idle") {
      await completeStreaming(exchangeId);
    } else {
      exchange.stage = "waiting";
      if (exchange.reconcileAgain) requestReconcile(exchangeId);
    }
  };

  function requestReconcile(exchangeId: string): void {
    const exchange = active;
    if (!exchange || exchange.exchangeId !== exchangeId || !exchange.requestId) return;
    if (exchange.stage === "resolving") {
      exchange.reconcileAgain = true;
      return;
    }
    if (exchange.stage !== "waiting") return;
    if (exchange.pumpRunning) {
      exchange.reconcileAgain = true;
      return;
    }
    runForExchange(exchangeId, () => reconcileTerminal(exchangeId));
  }

  const processUpload = async (
    exchangeId: string,
    mimeType: string,
    audio: Buffer,
  ): Promise<void> => {
    const exchange = active;
    if (!exchange || exchange.exchangeId !== exchangeId || exchange.stage !== "transcribing") return;
    const { speechServiceUrl } = await settings.get();
    if (active?.exchangeId !== exchangeId || exchange.stage !== "transcribing") return;
    const url = trimServiceUrl(speechServiceUrl);
    if (!url) throw new Error("speech service URL is empty");
    serviceUrls.set(exchangeId, url);

    const controller = new AbortController();
    exchangeControllers.set(exchangeId, controller);
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
    if (!response.ok) throw new Error(`transcription failed (HTTP ${response.status})`);
    const payload: unknown = await response.json();
    if (active?.exchangeId !== exchangeId || exchange.stage !== "transcribing") return;
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
    if (active?.exchangeId !== exchangeId || exchange.stage !== "transcribing") return;
    exchange.baselineSeq = String(timeline.maxSeq);
    exchange.transcript = transcript;
    exchange.stream = initialStreamState(exchange.baselineSeq);
    exchange.eventRows = [];
    exchange.eventSeqs.clear();
    exchange.stage = "sending";

    await bb.sdk.threads.send({
      threadId: exchange.threadId,
      mode: "start",
      input: [{ type: "text", text: transcript, mentions: [] }],
    });
    if (active?.exchangeId !== exchangeId || exchange.stage !== "sending") return;
    wake(exchangeId);
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
      if (thread.status !== "idle") return { ok: false, reason: "thread is busy" };
      const interactions = await bb.sdk.threads.interactions.list({
        threadId: input.threadId,
      });
      if (active && active.exchangeId !== replaceableId) {
        return { ok: false, reason: "voice is busy" };
      }
      if (interactions.some((interaction) => interaction.status === "pending")) {
        return { ok: false, reason: "thread needs input" };
      }

      if (replaceableId && active) {
        clearExchangeResources(active);
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
        transcript: null,
        stream: initialStreamState(),
        eventRows: [],
        eventSeqs: new Set(),
        terminalSignal: null,
        reconcileAgain: false,
        reconcilePrepared: false,
        streamComplete: false,
        ledger: new Map(),
        queuedIndexes: [],
        nextChunkIndex: 0,
        ttsJob: null,
        audioBytes: 0,
        lastAckIndex: -1,
        error: null,
        expiresAt: Date.now() + LISTENING_TTL_MS,
        pumpRunning: false,
        pumpAgain: false,
      };
      publishChanged(input.threadId);
      return { ok: true, exchangeId };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    } finally {
      unlock();
    }
  };

  bb.rpc.register(runtimeRpcContract, {
    getState(input) {
      const exchange = active;
      if (!exchange || exchange.threadId !== input.threadId) {
        return {
          phase: "ready" as const,
          exchangeId: null,
          error: null,
          canControl: false,
          chunks: [],
          streamComplete: false,
        };
      }
      updatePhase(exchange);
      const canControl = exchange.controllerId === input.controllerId;
      return {
        phase: exchange.phase,
        exchangeId: exchange.exchangeId,
        error: exchange.error,
        canControl,
        chunks: canControl
          ? [...exchange.ledger.values()]
              .filter((entry) => entry.state === "stashed")
              .sort((left, right) => left.index - right.index)
              .map((entry) => ({ id: entry.audioId, index: entry.index }))
          : [],
        streamComplete: exchange.streamComplete,
      };
    },
    reserve,
    ackPlayback(input) {
      return { ok: owns(input) && markAck(active!, input.playedThroughIndex) };
    },
    cancel(input) {
      if (!owns(input)) return { ok: false };
      return { ok: release(input.exchangeId) };
    },
    finishPlayback(input) {
      if (!owns(input) || !active || !active.streamComplete) return { ok: false };
      markAck(active, input.playedThroughIndex);
      if ([...active.ledger.values()].some((entry) => entry.state === "stashed")) {
        return { ok: false };
      }
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
      if (!exchange || exchange.exchangeId !== exchangeId || exchange.controllerId !== controllerId) {
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
        if (active?.exchangeId !== exchangeId || exchange.stage !== "transcribing") {
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
    const entry = audioId
      ? [...(active?.ledger.values() ?? [])].find((candidate) => candidate.audioId === audioId)
      : undefined;
    if (!entry?.audio || active?.phase === "failed") {
      return context.json({ error: "audio not found" }, 404);
    }
    return new Response(new Uint8Array(entry.audio), {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(entry.audio.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  bb.events.on("thread.idle", ({ thread }) => {
    const exchange = active;
    if (exchange?.threadId !== thread.id || exchange.stage === null || exchange.stage === "transcribing") return;
    if (exchange.stage === "sending") {
      wake(exchange.exchangeId);
      return;
    }
    rememberTerminal(exchange, { kind: "idle" });
    if (exchange.stage === "resolving") {
      exchange.reconcileAgain = true;
    } else if (exchange.requestId) {
      requestReconcile(exchange.exchangeId);
    } else {
      wake(exchange.exchangeId);
    }
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const exchange = active;
    if (exchange?.threadId !== thread.id || exchange.stage === null || exchange.stage === "transcribing") return;
    const signal: TerminalSignal = { kind: "failed", error: error || "thread turn failed" };
    if (exchange.stage === "resolving") {
      rememberTerminal(exchange, signal);
      return;
    }
    if (exchange.stage === "sending") {
      wake(exchange.exchangeId);
      return;
    }
    fail(exchange.exchangeId, signal.error);
  });

  const relevantEventTypes = new Set([
    "item/agentMessage/delta",
    "item/started",
    "item/completed",
    "turn/completed",
  ]);
  const unsubscribeThreadChanges = bb.sdk.subscribe({
    event: "thread:changed",
    callback(event) {
      const exchange = active;
      if (!exchange || event.id !== exchange.threadId) return;
      if (event.changes.includes("events-appended")) {
        const eventTypes = event.metadata?.eventTypes;
        if (!eventTypes || eventTypes.some((type) => relevantEventTypes.has(type))) {
          wake(exchange.exchangeId);
        }
      }
      if (event.changes.includes("interactions-changed")) {
        if (exchange.stage === "resolving") exchange.reconcileAgain = true;
        else requestReconcile(exchange.exchangeId);
      }
      if (event.changes.includes("status-changed")) wake(exchange.exchangeId);
    },
  });

  const unsubscribeReconnect = bb.sdk.subscribe({
    event: "realtime:connection",
    callback(event) {
      const exchange = active;
      if (!exchange || !event.reconnected || event.state !== "connected") return;
      wake(exchange.exchangeId);
      if (exchange.requestId && exchange.stage === "waiting") requestReconcile(exchange.exchangeId);
      if (exchange.stage === "resolving") exchange.reconcileAgain = true;
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
    if (active) {
      const threadId = active.threadId;
      clearExchangeResources(active);
      active = null;
      publishChanged(threadId);
    }
  });
}
