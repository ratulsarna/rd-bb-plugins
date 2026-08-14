import { describe, expect, it } from "vitest";
import { resolveView, type VoiceState } from "@/lib/view";

const base = {
  stage: "idle",
  playback: "idle",
  elapsedMs: 0,
  isCompact: false,
  isSupported: true,
} as const;

function state(overrides: Partial<VoiceState> = {}): VoiceState {
  return {
    phase: "ready",
    canControl: false,
    exchangeId: null,
    audioId: null,
    error: null,
    ...overrides,
  };
}

describe("resolveView", () => {
  it("offers the mic whenever voice is ready", () => {
    const view = resolveView({ ...base, state: state() });
    expect(view.action).toBe("start");
    expect(view.actionDisabled).toBe(false);
  });

  it("shows local recording even while the fetched state is still stale", () => {
    const view = resolveView({
      ...base,
      state: state(),
      stage: "recording",
      elapsedMs: 67_400,
    });
    expect(view.action).toBe("stop-recording");
    expect(view.actionDisabled).toBe(false);
    expect(view.label).toBe("Listening 1:07");
  });

  it("renders status only for a pane that does not own the exchange", () => {
    for (const phase of ["listening", "working", "speaking"] as const) {
      const view = resolveView({
        ...base,
        state: state({
          phase,
          canControl: false,
          exchangeId: "ex_1",
        }),
      });
      expect(view.action).toBe("none");
      expect(view.showStopPlayback).toBe(false);
      expect(view.showDismiss).toBe(false);
      expect(view.statusLabel).not.toBe("");
    }
  });

  it("falls back to an explicit play control when autoplay was refused", () => {
    const speaking = state({
      phase: "speaking",
      canControl: true,
      exchangeId: "ex_1",
      audioId: "aud_1",
    });
    expect(resolveView({ ...base, state: speaking }).action).toBe("none");

    const blocked = resolveView({ ...base, state: speaking, playback: "blocked" });
    expect(blocked.action).toBe("play");
    expect(blocked.showStopPlayback).toBe(true);
  });

  it("lets only the owner dismiss a failure, and always names the error", () => {
    const failure = {
      phase: "failed",
      exchangeId: "ex_1",
      error: "nothing transcribed",
    } as const;

    const owner = resolveView({
      ...base,
      state: state({ ...failure, canControl: true }),
    });
    expect(owner.showDismiss).toBe(true);
    expect(owner.label).toBe("nothing transcribed");

    const other = resolveView({
      ...base,
      state: state({ ...failure, canControl: false }),
    });
    expect(other.showDismiss).toBe(false);
    // Nobody is left to dismiss it, so recording again must be the way out.
    expect(other.action).toBe("start");
    expect(other.actionDisabled).toBe(false);
    expect(other.detail).toBe("nothing transcribed");
  });

  it("drops prose on compact viewports but keeps an accessible status", () => {
    const compact = resolveView({
      ...base,
      isCompact: true,
      state: state({ phase: "working", exchangeId: "ex_1" }),
    });
    expect(compact.label).toBe("");
    expect(compact.statusLabel).toBe("Working");
  });

  it("disables recording when the browser cannot capture audio", () => {
    const view = resolveView({ ...base, state: state(), isSupported: false });
    expect(view.actionDisabled).toBe(true);
    expect(view.detail).toMatch(/cannot record/i);
  });
});
