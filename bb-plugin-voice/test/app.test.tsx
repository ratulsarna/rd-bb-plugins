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
  endPlayback,
  fakes,
  installBrowserFakes,
  resetFakes,
} from "./browser-fakes";
import { configureFakeSdk, emitRealtime, registrations, rpcCalls } from "./sdk-fake";
import { toasts } from "./toast-fake";

const Control = registrations.threadHeaderActions[0]!.component;

const ready: VoiceState = {
  phase: "ready",
  canStart: true,
  canControl: false,
  exchangeId: null,
  audioId: null,
  error: null,
};

const owned = (overrides: Partial<VoiceState>): VoiceState => ({
  ...ready,
  canStart: false,
  canControl: true,
  exchangeId: "ex_1",
  ...overrides,
});

/** The single-slot backend, reduced to what the header control can observe. */
function createBackend() {
  const backend = {
    current: ready,
    handle(method: string): unknown {
      switch (method) {
        case "getState":
          return { ...backend.current };
        case "reserve":
          if (!backend.current.canStart) return { ok: false, reason: "voice is busy" };
          backend.current = owned({ phase: "listening" });
          return { ok: true, exchangeId: "ex_1" };
        case "cancel":
        case "finishPlayback":
          backend.current = ready;
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
  it("records, uploads, speaks the answer, and returns to ready", async () => {
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

    await publish(backend, owned({ phase: "speaking", audioId: "aud_1" }));
    await waitFor(() => expect(fakes.audioDownloads).toEqual(["aud_1"]));
    expect(await screen.findByText("Speaking")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Stop playback" }),
    ).toBeTruthy();

    await act(async () => endPlayback());
    await waitFor(() =>
      expect(rpcCalls.some((call) => call.method === "finishPlayback")).toBe(true),
    );
    expect(fakes.revokedUrls).toHaveLength(1);
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
    expect(await micButton()).toBeTruthy();
  });

  it("offers an explicit play control when autoplay is refused", async () => {
    const backend = createBackend();
    fakes.playResult = "reject";
    renderControl();
    await micButton();

    await publish(backend, owned({ phase: "speaking", audioId: "aud_1" }));
    const play = await screen.findByRole("button", {
      name: "Play the spoken answer",
    });

    fakes.playResult = "resolve";
    fireEvent.click(play);
    expect(await screen.findByText("Speaking")).toBeTruthy();
  });

  it("shows status only, and never fetches audio, for a pane it does not own", async () => {
    createBackend().current = {
      phase: "speaking",
      canStart: false,
      canControl: false,
      exchangeId: "ex_1",
      audioId: null,
      error: null,
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
    view.unmount();

    await waitFor(() => expect(fakes.tracksStopped).toBe(1));
    expect(
      rpcCalls.filter((call) => call.method === "cancel").at(-1)?.input,
    ).toMatchObject({ exchangeId: "ex_1" });
    expect(fakes.uploads).toHaveLength(0);
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
