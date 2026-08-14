/**
 * Minimal stand-ins for the browser capabilities the control drives: the mic,
 * the plugin HTTP routes, object URLs, and audio playback.
 */

export interface UploadRecord {
  query: Record<string, string>;
  token: string | null;
  contentType: string | null;
  sizeBytes: number;
}

export const fakes = {
  uploads: [] as UploadRecord[],
  audioDownloads: [] as string[],
  revokedUrls: [] as string[],
  tracksStopped: 0,
  recorders: [] as FakeMediaRecorder[],
  audios: [] as HTMLAudioElement[],
  /** How the next `play()` resolves — "reject" mimics a blocked autoplay. */
  playResult: "resolve" as "resolve" | "reject",
  micError: null as unknown,
  /** Thrown by `MediaRecorder.start()`, after the mic is already open. */
  recorderStartError: null as unknown,
  onUpload: (() => {}) as () => void,
};

export function resetFakes() {
  fakes.uploads.length = 0;
  fakes.audioDownloads.length = 0;
  fakes.revokedUrls.length = 0;
  fakes.recorders.length = 0;
  fakes.audios.length = 0;
  fakes.tracksStopped = 0;
  fakes.playResult = "resolve";
  fakes.micError = null;
  fakes.recorderStartError = null;
  fakes.onUpload = () => {};
}

class FakeMediaRecorder {
  static isTypeSupported(type: string): boolean {
    return type === "audio/webm";
  }

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    fakes.recorders.push(this);
  }

  start(): void {
    if (fakes.recorderStartError) throw fakes.recorderStartError;
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["fake-audio-bytes"], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)]),
  } as unknown as Response;
}

function parseQuery(url: string): Record<string, string> {
  const query = url.slice(url.indexOf("?") + 1);
  return Object.fromEntries(new URLSearchParams(query));
}

export function installBrowserFakes(): void {
  const scope = globalThis as unknown as Record<string, unknown>;

  scope.MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        if (fakes.micError) throw fakes.micError;
        return {
          getTracks: () => [
            {
              stop: () => {
                fakes.tracksStopped += 1;
              },
            },
          ],
        } as unknown as MediaStream;
      },
    },
  });

  let objectUrlSeq = 0;
  URL.createObjectURL = () => `blob:fake-${++objectUrlSeq}`;
  URL.revokeObjectURL = (url: string) => {
    fakes.revokedUrls.push(url);
  };

  const media = globalThis.HTMLMediaElement.prototype;
  media.play = function play() {
    return fakes.playResult === "resolve"
      ? Promise.resolve()
      : Promise.reject(new DOMException("blocked", "NotAllowedError"));
  };
  media.pause = function pause() {};

  const RealAudio = globalThis.Audio;
  scope.Audio = class TrackedAudio extends RealAudio {
    constructor(src?: string) {
      super(src);
      fakes.audios.push(this);
    }
  };

  scope.fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/token")) return jsonResponse({ token: "tok_test" });
    if (url.includes("/http/audio") && init?.method === "POST") {
      const headers = (init.headers ?? {}) as Record<string, string>;
      fakes.uploads.push({
        query: parseQuery(url),
        token: headers["x-bb-plugin-token"] ?? null,
        contentType: headers["content-type"] ?? null,
        sizeBytes: (init.body as Blob).size,
      });
      fakes.onUpload();
      return jsonResponse({ ok: true }, 202);
    }
    if (url.includes("/http/audio?id=")) {
      fakes.audioDownloads.push(parseQuery(url).id ?? "");
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["wav-bytes"], { type: "audio/wav" }),
        json: async () => ({}),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

/** Fire `ended` on the audio element the control is playing. */
export function endPlayback(): void {
  const audio = fakes.audios.at(-1);
  audio?.onended?.(new Event("ended"));
}

export type { FakeMediaRecorder };
