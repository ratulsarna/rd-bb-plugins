import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  isRecordingSupported,
  micErrorMessage,
  startRecording,
  type Recording,
  type RecorderHandle,
} from "@/lib/recorder";
import { PlaybackQueue } from "@/lib/playback-queue";
import { fetchAudioChunk, uploadRecording } from "@/lib/transport";
import {
  resolveView,
  type LocalStage,
  type PlaybackStage,
  type VoiceState,
  type VoiceView,
} from "@/lib/view";
import type { rpcContract } from "../server";

/** Hard stop, matching the backend's listening expiry with room to upload. */
const MAX_RECORDING_MS = 60_000;
const TICK_MS = 250;
/** How often an open mic re-checks that its exchange still exists. */
const OWNERSHIP_CHECK_MS = 5_000;

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface VoiceControlApi {
  view: VoiceView;
  start: () => void;
  stopRecording: () => void;
  play: () => void;
  stopPlayback: () => void;
  dismiss: () => void;
}

export function useVoice(threadId: string, isCompact: boolean): VoiceControlApi {
  const rpc = useRpc<typeof rpcContract>();
  // One controller per mount: a split layout gives each pane its own identity.
  const [controllerId] = useState(randomId);
  const [isSupported] = useState(isRecordingSupported);

  const [state, setState] = useState<VoiceState | null>(null);
  const [stage, setStage] = useState<LocalStage>("idle");
  const [playback, setPlayback] = useState<PlaybackStage>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);

  const mountedRef = useRef(true);
  const stageRef = useRef<LocalStage>("idle");
  const exchangeIdRef = useRef<string | null>(null);
  const recorderRef = useRef<RecorderHandle | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<PlaybackQueue | null>(null);
  const queueExchangeIdRef = useRef<string | null>(null);
  const settlingExchangeIdRef = useRef<string | null>(null);
  const fetchSeqRef = useRef(0);
  // Bumped by every local mutation so a getState answer that was issued before
  // it cannot overwrite the newer truth we already know.
  const mutationSeqRef = useRef(0);

  const queueCallbacksRef = useRef({
    onChunkPlayed: (_index: number) => {},
    onFinished: () => {},
    onInterrupted: () => {},
    onError: (_error: Error) => {},
  });

  const applyStage = useCallback((next: LocalStage) => {
    stageRef.current = next;
    setStage(next);
  }, []);

  const ensureAudioContext = useCallback((): AudioContext => {
    if (audioContextRef.current) return audioContextRef.current;
    if (typeof AudioContext === "undefined") {
      throw new Error("Web Audio is unavailable in this browser");
    }
    const context = new AudioContext();
    audioContextRef.current = context;
    return context;
  }, []);

  const createQueue = useCallback(
    (context: AudioContext) =>
      new PlaybackQueue(context, {
        fetchChunk: fetchAudioChunk,
        onChunkPlayed: (index) => queueCallbacksRef.current.onChunkPlayed(index),
        onFinished: () => queueCallbacksRef.current.onFinished(),
        onInterrupted: () => queueCallbacksRef.current.onInterrupted(),
        onError: (error) => queueCallbacksRef.current.onError(error),
      }),
    [],
  );

  const cancelExchange = useCallback(
    async (exchangeId: string, playedThroughIndex?: number) => {
      settlingExchangeIdRef.current = exchangeId;
      if (exchangeIdRef.current === exchangeId) exchangeIdRef.current = null;
      try {
        await rpc.call("cancel", {
          threadId,
          controllerId,
          exchangeId,
          ...(playedThroughIndex === undefined ? {} : { playedThroughIndex }),
        });
      } catch {
        // The backend's expiry sweep is the fallback.
      }
      mutationSeqRef.current += 1;
    },
    [controllerId, rpc, threadId],
  );

  const syncQueue = useCallback(
    (next: VoiceState) => {
      if (!next.canControl || !next.exchangeId) {
        settlingExchangeIdRef.current = null;
        if (queueExchangeIdRef.current) {
          queueRef.current?.stop();
          queueExchangeIdRef.current = null;
        }
        return;
      }

      if (settlingExchangeIdRef.current === next.exchangeId) return;
      if (settlingExchangeIdRef.current) settlingExchangeIdRef.current = null;

      exchangeIdRef.current = next.exchangeId;
      let queue = queueRef.current;
      if (!queue || queueExchangeIdRef.current !== next.exchangeId) {
        queue?.stop();
        queue = createQueue(ensureAudioContext());
        queueRef.current = queue;
        queueExchangeIdRef.current = next.exchangeId;
      }
      queue.applySnapshot(next.chunks, next.streamComplete);
    },
    [createQueue, ensureAudioContext],
  );

  const refresh = useCallback(async (): Promise<VoiceState | null> => {
    const seq = ++fetchSeqRef.current;
    const mutation = mutationSeqRef.current;
    try {
      const next = await rpc.call("getState", { threadId, controllerId });
      if (
        !mountedRef.current ||
        seq !== fetchSeqRef.current ||
        mutation !== mutationSeqRef.current
      ) {
        return null;
      }
      setState(next);
      try {
        syncQueue(next);
      } catch (error) {
        queueCallbacksRef.current.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return next;
    } catch {
      return null;
    }
  }, [controllerId, rpc, syncQueue, threadId]);

  const finishPlayback = useCallback(
    async (exchangeId: string, playedThroughIndex: number) => {
      settlingExchangeIdRef.current = exchangeId;
      if (exchangeIdRef.current === exchangeId) exchangeIdRef.current = null;
      try {
        await rpc.call("finishPlayback", {
          threadId,
          controllerId,
          exchangeId,
          playedThroughIndex,
        });
      } catch {
        // Expiry releases the slot if the call never lands.
      }
      mutationSeqRef.current += 1;
      void refresh();
    },
    [controllerId, refresh, rpc, threadId],
  );

  const primeAudio = useCallback(() => {
    try {
      const context = ensureAudioContext();
      void context
        .resume()
        .then(() => {
          if (mountedRef.current) setPlayback("idle");
        })
        .catch(() => {
          if (mountedRef.current) setPlayback("blocked");
        });
    } catch {
      if (mountedRef.current) setPlayback("blocked");
    }
  }, [ensureAudioContext]);

  const submit = useCallback(
    async (exchangeId: string, recording: Recording | null) => {
      recorderRef.current = null;
      if (!recording || recording.blob.size === 0) {
        toast.error("No audio was captured");
        await cancelExchange(exchangeId, queueRef.current?.playedThroughIndex());
        if (mountedRef.current) applyStage("idle");
        void refresh();
        return;
      }
      try {
        await uploadRecording({
          blob: recording.blob,
          mimeType: recording.mimeType,
          exchangeId,
          controllerId,
        });
        mutationSeqRef.current += 1;
      } catch (error) {
        toast.error("Voice message failed", { description: messageOf(error) });
        await cancelExchange(exchangeId, queueRef.current?.playedThroughIndex());
        if (mountedRef.current) applyStage("idle");
        void refresh();
        return;
      }
      // The upload route flips the exchange to working before it answers, so
      // this refresh always hands the chip over to the backend's phase.
      await refresh();
      if (mountedRef.current) applyStage("idle");
    },
    [applyStage, cancelExchange, controllerId, refresh],
  );

  const start = useCallback(() => {
    if (stageRef.current !== "idle" || !isSupported) return;
    // This call stays inside the record tap's user gesture. A browser that
    // still refuses it leaves the already-scheduled queue for explicit Play.
    primeAudio();
    applyStage("starting");
    void (async () => {
      let exchangeId: string;
      try {
        const result = await rpc.call("reserve", { threadId, controllerId });
        mutationSeqRef.current += 1;
        if (!result.ok || !result.exchangeId) {
          // The only place the live reason is told, now that the button no
          // longer pretends to know it ahead of the click.
          toast.error("Voice cannot start", { description: result.reason });
          applyStage("idle");
          void refresh();
          return;
        }
        exchangeId = result.exchangeId;
      } catch (error) {
        toast.error("Voice is unavailable", { description: messageOf(error) });
        applyStage("idle");
        return;
      }

      exchangeIdRef.current = exchangeId;
      try {
        recorderRef.current = await startRecording((recording) => {
          void submit(exchangeId, recording);
        });
      } catch (error) {
        toast.error(micErrorMessage(error));
        await cancelExchange(exchangeId, queueRef.current?.playedThroughIndex());
        applyStage("idle");
        void refresh();
        return;
      }
      if (!mountedRef.current) {
        // Unmounted while the mic was opening: never leave it running.
        recorderRef.current.dispose();
        recorderRef.current = null;
        void cancelExchange(exchangeId, queueRef.current?.playedThroughIndex());
        return;
      }
      setElapsedMs(0);
      applyStage("recording");
      void refresh();
    })();
  }, [
    applyStage,
    cancelExchange,
    controllerId,
    isSupported,
    primeAudio,
    refresh,
    rpc,
    submit,
    threadId,
  ]);

  const stopRecording = useCallback(() => {
    if (stageRef.current !== "recording") return;
    applyStage("uploading");
    recorderRef.current?.stop();
  }, [applyStage]);

  // Recording clock, the hard stop the plan requires, and — because an open mic
  // must never outlive its exchange — a re-read of the state it depends on. A
  // backend that forgot the exchange (plugin reload, server restart) publishes
  // nothing, so this is the only thing that would notice.
  useEffect(() => {
    if (stage !== "recording") return;
    const startedAt = Date.now();
    let checkedAt = 0;
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_RECORDING_MS) {
        stopRecording();
      } else if (elapsed - checkedAt >= OWNERSHIP_CHECK_MS) {
        checkedAt = elapsed;
        void refresh();
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [refresh, stage, stopRecording]);

  const stopPlayback = useCallback(() => {
    const exchangeId = exchangeIdRef.current ?? state?.exchangeId ?? null;
    const queue = queueRef.current;
    const playedThroughIndex = queue?.playedThroughIndex();
    if (exchangeId) settlingExchangeIdRef.current = exchangeId;
    queue?.stop();
    if (!exchangeId) return;
    void cancelExchange(exchangeId, playedThroughIndex).then(() => refresh());
  }, [cancelExchange, refresh, state]);

  const play = useCallback(() => {
    const context = audioContextRef.current;
    if (!context) return;
    void context
      .resume()
      .then(() => {
        if (mountedRef.current) setPlayback("idle");
      })
      .catch((error: unknown) => {
        toast.error("Could not play the answer", {
          description: messageOf(error),
        });
      });
  }, []);

  const dismiss = useCallback(() => {
    const exchangeId = state?.exchangeId;
    const queue = queueRef.current;
    const playedThroughIndex = queue?.playedThroughIndex();
    if (exchangeId) settlingExchangeIdRef.current = exchangeId;
    queue?.stop();
    if (!exchangeId) return;
    void cancelExchange(exchangeId, playedThroughIndex).then(() => refresh());
  }, [cancelExchange, refresh, state]);

  // Queue callbacks are kept in a ref so PlaybackQueue never needs to know
  // about React lifetimes or RPC ownership.
  queueCallbacksRef.current = {
    onChunkPlayed: (index) => {
      const exchangeId = exchangeIdRef.current;
      if (!exchangeId) return;
      void rpc
        .call("ackPlayback", {
          threadId,
          controllerId,
          exchangeId,
          playedThroughIndex: index,
        })
        .catch(() => {});
    },
    onFinished: () => {
      const exchangeId = exchangeIdRef.current;
      const queue = queueRef.current;
      if (!exchangeId || !queue) return;
      const playedThroughIndex = queue.playedThroughIndex();
      settlingExchangeIdRef.current = exchangeId;
      queue.stop();
      void finishPlayback(exchangeId, playedThroughIndex);
    },
    onInterrupted: () => {
      if (mountedRef.current) setPlayback("idle");
    },
    onError: (error) => {
      const exchangeId = exchangeIdRef.current;
      const queue = queueRef.current;
      if (!exchangeId) return;
      const playedThroughIndex = queue?.playedThroughIndex();
      settlingExchangeIdRef.current = exchangeId;
      toast.error("Could not play the answer", {
        description: messageOf(error),
      });
      queue?.stop();
      void cancelExchange(exchangeId, playedThroughIndex).then(() => refresh());
    },
  };

  // Ownership loss (backend restart, expiry, another controller): drop every
  // local resource instead of recording or playing into a dead exchange.
  useEffect(() => {
    const owned = exchangeIdRef.current;
    if (!state || !owned) return;
    if (state.exchangeId === owned && state.canControl) return;
    exchangeIdRef.current = null;
    queueRef.current?.stop();
    queueExchangeIdRef.current = null;
    recorderRef.current?.dispose();
    recorderRef.current = null;
    setPlayback("idle");
    if (stageRef.current !== "idle") {
      applyStage("idle");
      // The mic was open and what it captured is gone. Losing that silently
      // reads as a control that simply forgot what the user just said.
      toast.error("Recording discarded", {
        description: "This voice exchange is no longer active.",
      });
    }
  }, [applyStage, state]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onChanged = useCallback(() => {
    void refresh();
  }, [refresh]);
  useRealtime("voice:changed", onChanged);

  // Plugin signals are ephemeral, so reconcile after a dropped connection.
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current !== "connected" && connection === "connected") {
      void refresh();
    }
    previousConnection.current = connection;
  }, [connection, refresh]);

  // Kept in a ref so unmount cleanup never runs early on a dependency change.
  const disposeRef = useRef<() => void>(() => {});
  disposeRef.current = () => {
    recorderRef.current?.dispose();
    recorderRef.current = null;
    const queue = queueRef.current;
    const playedThroughIndex = queue?.playedThroughIndex();
    queue?.stop();
    const exchangeId = exchangeIdRef.current;
    exchangeIdRef.current = null;
    if (exchangeId) {
      void rpc
        .call("cancel", {
          threadId,
          controllerId,
          exchangeId,
          ...(playedThroughIndex === undefined ? {} : { playedThroughIndex }),
        })
        .catch(() => {});
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disposeRef.current();
    };
  }, []);

  return {
    view: resolveView({ state, stage, playback, elapsedMs, isCompact, isSupported }),
    start,
    stopRecording,
    play,
    stopPlayback,
    dismiss,
  };
}
