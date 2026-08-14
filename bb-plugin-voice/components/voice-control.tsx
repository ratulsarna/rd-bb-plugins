import type { ReactNode } from "react";
import type { PluginThreadHeaderActionProps } from "@bb/plugin-sdk/app";
import { useVoice } from "@/components/use-voice";
import type { VoiceTone } from "@/lib/view";

const TONE_TEXT: Record<VoiceTone, string> = {
  idle: "text-muted-foreground",
  recording: "text-destructive",
  busy: "text-muted-foreground",
  speaking: "text-foreground",
  failed: "text-destructive",
};

const BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

const MicIcon = () => (
  <Svg>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);

const StopIcon = () => (
  <Svg>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
  </Svg>
);

const PlayIcon = () => (
  <Svg>
    <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
  </Svg>
);

const SpeakerIcon = () => (
  <Svg>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    <path d="M17 9a4 4 0 0 1 0 6" />
  </Svg>
);

const AlertIcon = () => (
  <Svg>
    <path d="M12 4 3 19h18z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
);

const SpinnerIcon = () => (
  <svg
    aria-hidden
    className="size-3.5 animate-spin"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <circle cx="12" cy="12" r="9" className="opacity-25" />
    <path d="M21 12a9 9 0 0 0-9-9" />
  </svg>
);

const CloseIcon = () => (
  <Svg>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

/**
 * One inline control for the thread header: record, watch the exchange, and
 * hear the answer. Everything it shows comes from the backend's single voice
 * slot, so a second pane on the same thread reports status without owning it.
 */
export function VoiceControl({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { view, start, stopRecording, play, stopPlayback, dismiss } = useVoice(
    threadId,
    isCompactViewport,
  );

  const glyph =
    view.tone === "busy" ? (
      <SpinnerIcon />
    ) : view.tone === "failed" ? (
      <AlertIcon />
    ) : view.action === "stop-recording" ? (
      <StopIcon />
    ) : view.action === "play" ? (
      <PlayIcon />
    ) : view.tone === "speaking" ? (
      <SpeakerIcon />
    ) : (
      <MicIcon />
    );

  const onAction =
    view.action === "start"
      ? start
      : view.action === "stop-recording"
        ? stopRecording
        : view.action === "play"
          ? play
          : null;

  return (
    <div className={`flex h-7 items-center gap-1 ${TONE_TEXT[view.tone]}`}>
      {onAction ? (
        <button
          type="button"
          className={BUTTON}
          onClick={onAction}
          disabled={view.actionDisabled}
          aria-label={view.actionLabel}
          title={view.detail ?? view.actionLabel}
        >
          {glyph}
        </button>
      ) : (
        <span
          role="status"
          aria-label={view.statusLabel}
          title={view.detail ?? view.statusLabel}
          className="inline-flex size-7 shrink-0 items-center justify-center"
        >
          {glyph}
        </span>
      )}

      {view.label ? (
        <span
          className="max-w-40 truncate text-xs tabular-nums"
          title={view.detail ?? view.label}
        >
          {view.label}
        </span>
      ) : null}

      {view.showStopPlayback ? (
        <button
          type="button"
          className={BUTTON}
          onClick={stopPlayback}
          aria-label="Stop playback"
          title="Stop playback"
        >
          <StopIcon />
        </button>
      ) : null}

      {view.showDismiss ? (
        <button
          type="button"
          className={BUTTON}
          onClick={dismiss}
          aria-label="Dismiss the voice error"
          title="Dismiss"
        >
          <CloseIcon />
        </button>
      ) : null}
    </div>
  );
}
