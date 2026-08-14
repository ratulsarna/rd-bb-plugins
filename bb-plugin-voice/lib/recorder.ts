/** Same fallback order BB's own voice input uses (apps/app useVoiceInput). */
const MIME_CANDIDATES = ["audio/webm", "audio/mp4", "audio/ogg"];

export interface Recording {
  blob: Blob;
  mimeType: string;
}

export interface RecorderHandle {
  /** Stop the mic and deliver what was captured. */
  stop(): void;
  /** Release the mic without delivering anything. */
  dispose(): void;
}

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

export function preferredMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    MIME_CANDIDATES.find((candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    ) ?? null
  );
}

export function micErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No microphone was found";
      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is already in use";
      default:
        return "Could not start recording";
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Could not start recording";
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function safeStop(recorder: MediaRecorder): void {
  if (recorder.state === "inactive") return;
  try {
    recorder.stop();
  } catch {
    // A recorder that refuses to stop has already ended.
  }
}

/**
 * Open the mic and record until `stop()`. `onComplete` fires exactly once with
 * the captured audio, or with null when nothing usable was captured. The mic
 * is always released before it fires.
 */
export async function startRecording(
  onComplete: (recording: Recording | null) => void,
): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = preferredMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
  } catch (error) {
    stopTracks(stream);
    throw error;
  }

  const chunks: Blob[] = [];
  let settled = false;
  const settle = (recording: Recording | null) => {
    if (settled) return;
    settled = true;
    stopTracks(stream);
    onComplete(recording);
  };

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onerror = () => {
    safeStop(recorder);
    settle(null);
  };
  recorder.onstop = () => {
    const type = recorder.mimeType || mimeType || "audio/webm";
    settle(chunks.length ? { blob: new Blob(chunks, { type }), mimeType: type } : null);
  };
  // Timeslice keeps chunks flowing so a stop always has data to flush.
  recorder.start(250);

  return {
    stop() {
      safeStop(recorder);
    },
    dispose() {
      settled = true;
      safeStop(recorder);
      stopTracks(stream);
    },
  };
}
