import { describe, expect, it } from "vitest";
import { calculatePace, inferWindowDurationMs } from "./pace";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const reset = "2026-08-09T12:00:00.000Z";

const at = (iso: string) => () => new Date(iso);

describe("inferWindowDurationMs", () => {
  it("recognizes only supported Codex windows and model-scoped Claude windows", () => {
    expect(inferWindowDurationMs("codex", "Current session")).toBe(5 * HOUR_MS);
    expect(inferWindowDurationMs("codex", "5-hour limit")).toBe(5 * HOUR_MS);
    expect(inferWindowDurationMs("codex", "Weekly limit")).toBe(7 * DAY_MS);
    expect(inferWindowDurationMs("codex", "7-day rolling")).toBe(7 * DAY_MS);
    expect(inferWindowDurationMs("codex", "GPT-5.4")).toBeNull();
    expect(inferWindowDurationMs("claudeCode", "Sonnet")).toBe(7 * DAY_MS);
    expect(inferWindowDurationMs("claudeCode", "   ")).toBeNull();
  });
});

describe("calculatePace", () => {
  it("clamps elapsed time and hides pace before 3% of the window", () => {
    const input = {
      providerId: "codex" as const,
      label: "Current session",
      usedPercent: 50,
      resetsAt: reset,
    };

    expect(calculatePace(input, at("2026-08-09T06:00:00.000Z"))).toBeNull();
    expect(calculatePace(input, at("2026-08-09T07:08:59.000Z"))).toBeNull();
    expect(calculatePace(input, at("2026-08-09T07:09:00.000Z"))).toEqual({
      kind: "deficit",
      percentage: 47,
    });
    expect(calculatePace(input, at(reset))).toEqual({
      kind: "reserve",
      percentage: 50,
    });
  });

  it("uses the raw two-point boundary before rounding the displayed delta", () => {
    const base = {
      providerId: "codex" as const,
      label: "5 hours",
      resetsAt: reset,
    };
    const halfway = at("2026-08-09T09:30:00.000Z");

    expect(calculatePace({ ...base, usedPercent: 52 }, halfway)).toEqual({
      kind: "on_pace",
      percentage: 0,
    });
    expect(calculatePace({ ...base, usedPercent: 52.1 }, halfway)).toEqual({
      kind: "deficit",
      percentage: 2,
    });
    expect(calculatePace({ ...base, usedPercent: 47.4 }, halfway)).toEqual({
      kind: "reserve",
      percentage: 3,
    });
  });

  it("returns null for bad reset times, non-finite usage, and unknown windows", () => {
    const base = {
      providerId: "codex" as const,
      label: "Current session",
      usedPercent: 40,
      resetsAt: reset,
    };

    expect(calculatePace({ ...base, resetsAt: "not-a-date" }, at(reset))).toBeNull();
    expect(calculatePace({ ...base, usedPercent: Number.NaN }, at(reset))).toBeNull();
    expect(
      calculatePace({ ...base, label: "Unrecognized window" }, at(reset)),
    ).toBeNull();
  });
});
