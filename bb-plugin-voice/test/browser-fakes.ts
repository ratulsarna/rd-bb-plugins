/**
 * Minimal stand-ins for the browser capabilities the control drives: the mic,
 * the plugin HTTP routes, and Web Audio playback.
 */

export interface UploadRecord {
  query: Record<string, string>;
  token: string | null;
  contentType: string | null;
  sizeBytes: number;
}

class FakeGainParam {
  value = 1;

  setValueAtTime(value: number): void {
    this.value = value;
  }

  cancelScheduledValues(): void {}

  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeGainNode {
  readonly gain = new FakeGainParam();

  connect(): void {}
}

class FakeAudioBufferSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startAt: number | null = null;
  stopAt: number | null = null;

  constructor(readonly gain: FakeGainNode) {}

  connect(): void {}

  start(at: number): void {
    this.startAt = at;
  }

  stop(at: number): void {
    this.stopAt = at;
  }

  finish(): void {
    const onended = this.onended;
    this.onended = null;
    onended?.();
  }
}

class FakeAudioContext {
  private stateValue: "running" | "suspended" | "closed";
  currentTime = 0;
  readonly destination = {} as AudioNode;
  readonly sources: FakeAudioBufferSource[] = [];
  private readonly stateListeners = new Set<() => void>();

  get state(): "running" | "suspended" | "closed" {
    return this.stateValue;
  }

  set state(next: "running" | "suspended" | "closed") {
    if (this.stateValue === next) return;
    this.stateValue = next;
    for (const listener of this.stateListeners) listener();
  }

  constructor() {
    this.stateValue = fakes.audioContextState;
    fakes.audioContexts.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "statechange") this.stateListeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "statechange") this.stateListeners.delete(listener);
  }

  resume(): Promise<void> {
    if (fakes.resumeResult !== "resolve") {
      return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    }
    if (fakes.resumeChangesState && this.state === "suspended") {
      this.state = "running";
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeAudioBufferSource(new FakeGainNode());
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    return this.sources.at(-1)!.gain as unknown as GainNode;
  }

  async decodeAudioData(_bytes: ArrayBuffer): Promise<AudioBuffer> {
    return { duration: 1 } as AudioBuffer;
  }
}

export const fakes = {
  uploads: [] as UploadRecord[],
  audioDownloads: [] as string[],
  audioDownloadStatus: 200,
  tracksStopped: 0,
  recorders: [] as FakeMediaRecorder[],
  audioContexts: [] as FakeAudioContext[],
  /** How the next `AudioContext.resume()` resolves. */
  resumeResult: "resolve" as "resolve" | "reject",
  audioContextState: "running" as "running" | "suspended",
  resumeChangesState: true,
  micError: null as unknown,
  /** Thrown by `MediaRecorder.start()`, after the mic is already open. */
  recorderStartError: null as unknown,
  onUpload: (() => {}) as () => void,
};

export function resetFakes() {
  fakes.uploads.length = 0;
  fakes.audioDownloads.length = 0;
  fakes.audioDownloadStatus = 200;
  fakes.recorders.length = 0;
  fakes.audioContexts.length = 0;
  fakes.tracksStopped = 0;
  fakes.resumeResult = "resolve";
  fakes.audioContextState = "running";
  fakes.resumeChangesState = true;
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

  scope.AudioContext = FakeAudioContext;

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
        ok: fakes.audioDownloadStatus < 400,
        status: fakes.audioDownloadStatus,
        arrayBuffer: async () => new TextEncoder().encode("wav-bytes").buffer,
        json: async () => ({}),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

/** Fire `ended` on the latest scheduled Web Audio source. */
export function endAudio(): void {
  const source = fakes.audioContexts
    .at(-1)
    ?.sources.find((candidate) => candidate.onended !== null);
  source?.finish();
}

export type { FakeMediaRecorder };
