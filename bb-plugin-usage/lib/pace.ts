export type ProviderId = "codex" | "claudeCode";

export type Clock = () => Date;

export interface Pace {
  kind: "deficit" | "reserve" | "on_pace";
  percentage: number;
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const clampPercent = (value: number): number =>
  Math.min(100, Math.max(0, value));

export function inferWindowDurationMs(
  providerId: ProviderId,
  label: string,
): number | null {
  const normalized = label.trim().toLowerCase();

  if (
    normalized === "current session" ||
    /\b5[\s-]*(?:hours?|hrs?)\b/.test(normalized)
  ) {
    return 5 * HOUR_MS;
  }

  if (
    /\bweekly\b/.test(normalized) ||
    /\b7[\s-]*(?:days?)\b/.test(normalized)
  ) {
    return 7 * DAY_MS;
  }

  if (providerId === "claudeCode" && normalized.length > 0) {
    return 7 * DAY_MS;
  }

  return null;
}

export function calculatePace(
  input: {
    providerId: ProviderId;
    label: string;
    usedPercent: number;
    resetsAt: string | null;
  },
  clock: Clock = () => new Date(),
): Pace | null {
  const durationMs = inferWindowDurationMs(input.providerId, input.label);
  if (durationMs === null || input.resetsAt === null) return null;
  if (!Number.isFinite(input.usedPercent)) return null;

  const resetMs = Date.parse(input.resetsAt);
  const nowMs = clock().getTime();
  if (!Number.isFinite(resetMs) || !Number.isFinite(nowMs)) return null;

  const startMs = resetMs - durationMs;
  const expectedUsed = clampPercent(((nowMs - startMs) / durationMs) * 100);
  if (expectedUsed < 3) return null;

  const actualUsed = clampPercent(input.usedPercent);
  const delta = actualUsed - expectedUsed;
  if (Math.abs(delta) <= 2) {
    return { kind: "on_pace", percentage: 0 };
  }

  return {
    kind: delta > 0 ? "deficit" : "reserve",
    percentage: Math.round(Math.abs(delta)),
  };
}
