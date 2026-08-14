import type { PluginRpcResult } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server";

export type VoiceState = PluginRpcResult<(typeof rpcContract)["getState"]>;

/** What this control is doing locally, ahead of what the backend has published. */
export type LocalStage = "idle" | "starting" | "recording" | "uploading";
export type PlaybackStage = "idle" | "loading" | "playing" | "blocked";

export type VoiceTone = "idle" | "recording" | "busy" | "speaking" | "failed";
/** `none` renders a status glyph instead of a button. */
export type VoiceAction = "start" | "stop-recording" | "play" | "none";

export interface VoiceView {
  tone: VoiceTone;
  /** Chip text beside the glyph; empty renders no chip. */
  label: string;
  /** Always-meaningful text for assistive software, including when compact. */
  statusLabel: string;
  action: VoiceAction;
  /** Accessible name and tooltip for the action button. */
  actionLabel: string;
  actionDisabled: boolean;
  showStopPlayback: boolean;
  showDismiss: boolean;
  /** Why the mic is unavailable, or what failed. */
  detail: string | null;
}

const NO_ACTION = {
  action: "none",
  actionLabel: "",
  actionDisabled: true,
  showStopPlayback: false,
  showDismiss: false,
  detail: null,
} as const;

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function resolveView(input: {
  state: VoiceState | null;
  stage: LocalStage;
  playback: PlaybackStage;
  elapsedMs: number;
  isCompact: boolean;
  isSupported: boolean;
}): VoiceView {
  const { state, stage, playback, elapsedMs, isCompact, isSupported } = input;

  if (stage === "recording") {
    const time = formatElapsed(elapsedMs);
    return {
      ...NO_ACTION,
      tone: "recording",
      label: isCompact ? time : `Listening ${time}`,
      statusLabel: `Listening, ${time}`,
      action: "stop-recording",
      actionLabel: "Stop recording and send",
      actionDisabled: false,
    };
  }
  if (stage === "starting" || stage === "uploading") {
    const text = stage === "starting" ? "Starting" : "Sending";
    return {
      ...NO_ACTION,
      tone: "busy",
      label: isCompact ? "" : text,
      statusLabel: text,
    };
  }

  if (!isSupported) {
    return {
      ...NO_ACTION,
      tone: "idle",
      label: "",
      statusLabel: "Voice recording is unavailable",
      action: "start",
      actionLabel: "Voice recording is unavailable",
      detail: "This browser cannot record audio.",
    };
  }
  if (!state) {
    return {
      ...NO_ACTION,
      tone: "idle",
      label: "",
      statusLabel: "Voice",
      action: "start",
      actionLabel: "Record a voice message",
    };
  }

  switch (state.phase) {
    case "ready":
      return {
        ...NO_ACTION,
        tone: "idle",
        label: "",
        statusLabel: "Voice ready",
        action: "start",
        actionLabel: "Record a voice message",
        actionDisabled: !state.canStart,
        detail: state.canStart
          ? null
          : "Voice is busy or this thread is not idle.",
      };
    // Another control on this thread is recording; this one only reports.
    case "listening":
      return {
        ...NO_ACTION,
        tone: "recording",
        label: "Listening",
        statusLabel: "Listening",
      };
    case "working":
      return {
        ...NO_ACTION,
        tone: "busy",
        label: isCompact ? "" : "Working",
        statusLabel: "Working",
      };
    case "speaking": {
      if (!state.canControl) {
        return {
          ...NO_ACTION,
          tone: "speaking",
          label: isCompact ? "" : "Speaking",
          statusLabel: "Speaking",
        };
      }
      if (playback === "blocked") {
        return {
          ...NO_ACTION,
          tone: "speaking",
          label: isCompact ? "" : "Play answer",
          statusLabel: "The answer is ready to play",
          action: "play",
          actionLabel: "Play the spoken answer",
          actionDisabled: false,
          showStopPlayback: true,
        };
      }
      const text = playback === "loading" ? "Loading" : "Speaking";
      return {
        ...NO_ACTION,
        tone: "speaking",
        label: isCompact ? "" : text,
        statusLabel: text,
        showStopPlayback: true,
      };
    }
    case "failed": {
      const error = state.error ?? "Voice failed";
      return {
        ...NO_ACTION,
        tone: "failed",
        label: isCompact ? "Failed" : error,
        statusLabel: `Voice failed: ${error}`,
        showDismiss: state.canControl,
        detail: error,
      };
    }
  }
}
