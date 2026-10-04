import { describe, expect, it } from "vitest";
import { formatWakeTime, snoozePresets } from "./snooze";

// Local wall-clock dates, so the expectations hold in any test machine's zone.
const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);
const labels = (now: Date) => snoozePresets(now).map((preset) => preset.label);
const untilOf = (now: Date, label: string) =>
  snoozePresets(now).find((preset) => preset.label === label)?.until;

describe("snoozePresets", () => {
  it("offers this evening until 6 pm, and not from 6 pm on", () => {
    expect(labels(local(2026, 10, 6, 17, 59))).toContain("This evening");
    expect(untilOf(local(2026, 10, 6, 17, 59), "This evening")).toBe(
      local(2026, 10, 6, 18).getTime(),
    );
    expect(labels(local(2026, 10, 6, 18, 0))).not.toContain("This evening");
  });

  it("makes next week the Monday after, never today", () => {
    // 2026-10-05 is a Monday.
    expect(untilOf(local(2026, 10, 5, 8), "Next week")).toBe(
      local(2026, 10, 12, 9).getTime(),
    );
    expect(untilOf(local(2026, 10, 4, 23), "Next week")).toBe(
      local(2026, 10, 5, 9).getTime(),
    );
  });

  it("rolls tomorrow over a month end", () => {
    expect(untilOf(local(2026, 10, 31, 23, 30), "Tomorrow")).toBe(
      local(2026, 11, 1, 9).getTime(),
    );
  });

  it("only ever offers future times", () => {
    for (const now of [local(2026, 10, 5, 0, 0), local(2026, 10, 4, 23, 59), local(2026, 10, 6, 17, 59)]) {
      for (const preset of snoozePresets(now)) {
        expect(preset.until).toBeGreaterThan(now.getTime());
      }
    }
  });
});

describe("formatWakeTime", () => {
  it("names the day only when it is not today", () => {
    const now = local(2026, 10, 6, 10).getTime();
    const time = (h: number) =>
      local(2026, 10, 6, h).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(formatWakeTime(local(2026, 10, 6, 18).getTime(), now)).toBe(time(18));
    expect(formatWakeTime(local(2026, 10, 7, 9).getTime(), now)).toBe(`Tomorrow ${time(9)}`);
  });
});
