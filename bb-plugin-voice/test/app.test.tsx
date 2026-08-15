// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../app";
import type { VoiceState } from "@/lib/view";
import {
  endAudio,
  fakes,
  installBrowserFakes,
  resetFakes,
} from "./browser-fakes";
import { configureFakeSdk, emitRealtime, registrations, rpcCalls } from "./sdk-fake";
import { toasts } from "./toast-fake";

const Control = registrations.threadHeaderActions[0]!.component;

const ready: VoiceState = {
  phase: "ready",
  canControl: false,
  exchangeId: null,
  error: null,
  chunks: [],
  streamComplete: false,
};

const owned = (overrides: Partial<VoiceState>): VoiceState => ({
  ...ready,
  canControl: true,
  exchangeId: "ex_1",
  ...overrides,
});

/** The single-slot backend, reduced to what the header control can observe. */
function createBackend() {
  const backend = {
    current: ready,
    reserveReason: null as string | null,
    handle(method: string): unknown {
      switch (method) {
        case "getState":
          return { ...backend.current };
        case "reserve":
          if (backend.reserveReason) {
            return { ok: false, reason: backend.reserveReason };
          }
          backend.current = owned({ phase: "listening" });
          return { ok: true, exchangeId: "ex_1" };
        case "cancel":
        case "finishPlayback":
          backend.current = ready;
          return { ok: true };
        case "ackPlayback":
          return { ok: true };
        default:
          throw new Error(`unexpected rpc: ${method}`);
      }
    },
  };
  configureFakeSdk({ handler: (method) => backend.handle(method) });
  return backend;
}

function renderControl() {
  return render(
    <Control threadId="thr_1" projectId="proj_1" isCompactViewport={false} />,
  );
}

const micButton = () =>
  screen.findByRole("button", { name: "Record a voice message" });
const stopRecordingButton = () =>
  screen.findByRole("button", { name: "Stop recording and send" });

/** Publish a backend phase change the way `voice:changed` reaches the client. */
async function publish(backend: { current: VoiceState }, next: VoiceState) {
  await act(async () => {
    backend.current = next;
    emitRealtime("voice:changed", { threadId: "thr_1" });
  });
}

beforeAll(installBrowserFakes);

beforeEach(() => {
  resetFakes();
  toasts.length = 0;
});

afterEach(cleanup);

describe("voice header control", () => {
  it("records, uploads, schedules the answer, and supports two serial exchanges", async () => {
    const backend = createBackend();
    renderControl();

    fireEvent.click(await micButton());
    await stopRecordingButton();
    expect(await screen.findByText(/Listening/)).toBeTruthy();

    fakes.onUpload = () => {
      backend.current = owned({ phase: "working" });
    };
    fireEvent.click(await stopRecordingButton());

    await waitFor(() => expect(fakes.uploads).toHaveLength(1));
    const upload = fakes.uploads[0]!;
    const reserve = rpcCalls.find((call) => call.method === "reserve")!
      .input as { controllerId: string };
    expect(upload.query).toEqual({
      exchangeId: "ex_1",
      controllerId: reserve.controllerId,
      mimeType: "audio/webm",
    });
    expect(upload.token).toBe("tok_test");
    expect(upload.sizeBytes).toBeGreaterThan(0);
    // The mic is released the moment recording stops, not at unmount.
    expect(fakes.tracksStopped).toBe(1);
    expect(await screen.findByText("Working")).toBeTruthy();

    await publish(
      backend,
      owned({
        phase: "speaking",
        chunks: [
          { id: "aud_1", index: 0 },
          { id: "aud_2", index: 1 },
        ],
        streamComplete: true,
      }),
    );
    await waitFor(() => expect(fakes.audioDownloads).toEqual(["aud_1", "aud_2"]));
    expect(await screen.findByText("Speaking")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Stop playback" }),
    ).toBeTruthy();

    await act(async () => endAudio());
    await act(async () => endAudio());
    await waitFor(() =>
      expect(rpcCalls.some((call) => call.method === "finishPlayback")).toBe(true),
    );
    expect(await micButton()).toBeTruthy();

    // A second exchange starts on the same mount without a reload.
    fireEvent.click(await micButton());
    expect(await stopRecordingButton()).toBeTruthy();
  });

  it("releases the reserved slot when the mic is denied", async () => {
    const backend = createBackend();
    renderControl();

    fakes.micError = new DOMException("denied", "NotAllowedError");
    fireEvent.click(await micButton());

    await waitFor(() =>
      expect(rpcCalls.some((call) => call.method === "cancel")).toBe(true),
    );
    expect(toasts[0]?.message).toBe("Microphone permission denied");
    expect(fakes.uploads).toHaveLength(0);
    expect(backend.current.phase).toBe("ready");
    expect(await micButton()).toBeTruthy();
  });

  it("releases the mic when the recorder refuses to start", async () => {
    const backend = createBackend();
    renderControl();

    // getUserMedia already handed over a live stream at this point, so a
    // failure here leaves the mic on unless the recorder releases it.
    fakes.recorderStartError = new DOMException("nope", "InvalidStateError");
    fireEvent.click(await micButton());

    await waitFor(() => expect(fakes.tracksStopped).toBe(1));
    await waitFor(() =>
      expect(rpcCalls.some((call) => call.method === "cancel")).toBe(true),
    );
    expect(toasts[0]?.message).toBe("Could not start recording");
    expect(backend.current.phase).toBe("ready");
    expect(await micButton()).toBeTruthy();
  });

  it("surfaces the backend's reason, and opens no mic, when the click loses the race", async () => {
    // The thread went busy after the last fetched state said it was idle.
    const backend = createBackend();
    backend.reserveReason = "voice is busy";
    renderControl();

    fireEvent.click(await micButton());

    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatchObject({
      message: "Voice cannot start",
      description: "voice is busy",
    });
    expect(fakes.recorders).toHaveLength(0);
    expect(await micButton()).toBeTruthy();
  });

  it("records again over a failed exchange whose owning pane is gone", async () => {
    const backend = createBackend();
    // Nobody can dismiss this one: the controller that owned it never came back.
    backend.current = {
      phase: "failed",
      canControl: false,
      exchangeId: "ex_dead",
      error: "nothing transcribed",
      chunks: [],
      streamComplete: false,
    };
    renderControl();

    expect(await screen.findByText("nothing transcribed")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Dismiss the voice error" }),
    ).toBeNull();

    fireEvent.click(
      await screen.findByRole("button", { name: "Record a new voice message" }),
    );
    expect(await stopRecordingButton()).toBeTruthy();
  });

  it("stops the recorder when the exchange is lost mid-recording", async () => {
    const backend = createBackend();
    renderControl();

    fireEvent.click(await micButton());
    await stopRecordingButton();

    // Backend restart / expiry: the slot is free again and nobody owns it.
    await publish(backend, ready);

    await waitFor(() => expect(fakes.tracksStopped).toBe(1));
    expect(fakes.recorders[0]!.state).toBe("inactive");
    expect(fakes.uploads).toHaveLength(0);
    // Losing what was just said has to be said out loud.
    expect(toasts.at(-1)).toMatchObject({ message: "Recording discarded" });
    expect(await micButton()).toBeTruthy();
  });

  it("offers an explicit play control when autoplay is refused", async () => {
    const backend = createBackend();
    fakes.audioContextState = "suspended";
    fakes.resumeChangesState = false;
    renderControl();
    fireEvent.click(await micButton());
    await stopRecordingButton();
    fakes.onUpload = () => {
      backend.current = owned({ phase: "working" });
    };
    fireEvent.click(await stopRecordingButton());
    await waitFor(() => expect(fakes.uploads).toHaveLength(1));

    await publish(
      backend,
      owned({
        phase: "speaking",
        chunks: [{ id: "aud_1", index: 0 }],
        streamComplete: true,
      }),
    );
    const play = await screen.findByRole("button", {
      name: "Play the spoken answer",
    });
    expect(fakes.audioContexts[0]!.state).toBe("suspended");

    fakes.resumeChangesState = true;
    fireEvent.click(play);
    expect(await screen.findByText("Speaking")).toBeTruthy();
    expect(fakes.audioContexts[0]!.state).toBe("running");
  });

  it("does not cancel when a missing chunk is superseded by the next snapshot", async () => {
    const backend = createBackend();
    fakes.audioDownloadStatus = 404;
    renderControl();

    await publish(
      backend,
      owned({
        phase: "speaking",
        chunks: [{ id: "gone", index: 0 }],
        streamComplete: false,
      }),
    );
    await waitFor(() => expect(fakes.audioDownloads).toEqual(["gone"]));
    expect(rpcCalls.some((call) => call.method === "cancel")).toBe(false);
    expect(toasts).toHaveLength(0);

    await publish(
      backend,
      owned({ phase: "working", chunks: [], streamComplete: false }),
    );
    expect(rpcCalls.some((call) => call.method === "cancel")).toBe(false);
    expect(toasts).toHaveLength(0);
  });

  it("shows status only, and never fetches audio, for a pane it does not own", async () => {
    createBackend().current = {
      phase: "speaking",
      canControl: false,
      exchangeId: "ex_1",
      error: null,
      chunks: [],
      streamComplete: false,
    };
    renderControl();

    expect(await screen.findByText("Speaking")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(fakes.audioDownloads).toHaveLength(0);
  });

  it("cancels the reservation when the pane closes mid-recording", async () => {
    createBackend();
    const view = renderControl();

    fireEvent.click(await micButton());
    await stopRecordingButton();
    const context = fakes.audioContexts[0]!;
    view.unmount();

    await waitFor(() => expect(fakes.tracksStopped).toBe(1));
    expect(context.state).toBe("closed");
    expect(
      rpcCalls.filter((call) => call.method === "cancel").at(-1)?.input,
    ).toEqual({
      threadId: "thr_1",
      controllerId: expect.any(String),
      exchangeId: "ex_1",
    });
    expect(fakes.uploads).toHaveLength(0);
  });

  it("drops an open mic when the backend silently forgets the exchange", async () => {
    vi.useFakeTimers();
    const flush = async () => {
      for (let tick = 0; tick < 8; tick += 1) await act(async () => {});
    };
    try {
      const backend = createBackend();
      renderControl();
      await flush();

      fireEvent.click(
        screen.getByRole("button", { name: "Record a voice message" }),
      );
      await flush();
      expect(
        screen.getByRole("button", { name: "Stop recording and send" }),
      ).toBeTruthy();

      // A plugin reload or server restart: the slot is gone and, unlike a phase
      // change, nothing is published to say so.
      backend.current = ready;
      await act(async () => {
        vi.advanceTimersByTime(6_000);
      });
      await flush();

      expect(fakes.tracksStopped).toBe(1);
      expect(fakes.recorders[0]!.state).toBe("inactive");
      expect(fakes.uploads).toHaveLength(0);
      expect(
        screen.getByRole("button", { name: "Record a voice message" }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard-stops a recording that runs past the 60 second cap", async () => {
    // Fake timers must own the recording clock from the moment it starts.
    vi.useFakeTimers();
    const flush = async () => {
      for (let tick = 0; tick < 8; tick += 1) await act(async () => {});
    };
    try {
      const backend = createBackend();
      renderControl();
      await flush();

      fireEvent.click(
        screen.getByRole("button", { name: "Record a voice message" }),
      );
      await flush();
      expect(
        screen.getByRole("button", { name: "Stop recording and send" }),
      ).toBeTruthy();

      fakes.onUpload = () => {
        backend.current = owned({ phase: "working" });
      };
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await flush();

      expect(fakes.uploads).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
