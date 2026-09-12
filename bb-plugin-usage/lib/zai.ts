import type { RawUsageProvider, RawUsageWindow } from "./usage";

export const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
export const ZAI_REQUEST_TIMEOUT_MS = 15_000;

// Z.ai counts a limit's window in `number` units of `unit`.
const UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 };
const UNIT_NAMES: Record<number, string> = { 1: "day", 3: "hour", 5: "minute", 6: "week" };
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;

interface ZaiLimit {
  type: string;
  unit: number;
  number: number;
  percentage: number;
  usage: number | null;
  currentValue: number | null;
  remaining: number | null;
  nextResetTime: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) throw new Error("Z.ai limit field is not an integer");
  return value as number;
}

function parseLimit(raw: unknown): ZaiLimit | null {
  if (
    !isRecord(raw) ||
    typeof raw.type !== "string" ||
    !Number.isInteger(raw.unit) ||
    !Number.isInteger(raw.number) ||
    !Number.isInteger(raw.percentage)
  ) {
    throw new Error("Z.ai limit entry is malformed");
  }
  if (!["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(raw.type)) return null;
  return {
    type: raw.type,
    unit: raw.unit as number,
    number: raw.number as number,
    percentage: raw.percentage as number,
    usage: optionalInteger(raw.usage),
    currentValue: optionalInteger(raw.currentValue),
    remaining: optionalInteger(raw.remaining),
    nextResetTime: optionalInteger(raw.nextResetTime),
  };
}

function windowMinutes(limit: ZaiLimit): number | null {
  // Z.ai reports its monthly MCP allowance as a one-minute TIME_LIMIT.
  if (limit.type === "TIME_LIMIT" && limit.unit === 5 && limit.number === 1) return 30 * 1440;
  const perUnit = UNIT_MINUTES[limit.unit];
  return limit.number > 0 && perUnit ? limit.number * perUnit : null;
}

export function windowLabel(limit: Pick<ZaiLimit, "type" | "unit" | "number">): string {
  if (limit.type === "TIME_LIMIT") return "MCP";
  const minutes = windowMinutes({ ...limit, percentage: 0, usage: null, currentValue: null, remaining: null, nextResetTime: null });
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "Weekly";
  if (minutes === 30 * 1440) return "Monthly";
  const unit = UNIT_NAMES[limit.unit];
  return unit ? `${limit.number} ${unit}${limit.number === 1 ? "" : "s"} window` : "Quota";
}

// Prefer the raw counters over Z.ai's rounded percentage when they are present.
export function usedPercent(limit: ZaiLimit): number {
  let percent = limit.percentage;
  if (limit.usage !== null && limit.usage > 0) {
    let used: number | null = null;
    if (limit.remaining !== null) {
      used = Math.max(limit.usage - limit.remaining, limit.currentValue ?? limit.usage - limit.remaining);
    } else if (limit.currentValue !== null) {
      used = limit.currentValue;
    }
    if (used !== null) percent = (Math.max(0, Math.min(limit.usage, used)) / limit.usage) * 100;
  }
  return Math.max(0, Math.min(100, percent));
}

function toWindow(limit: ZaiLimit, nowMs: number): RawUsageWindow {
  const minutes = windowMinutes(limit);
  let resetsAt: string | null = null;
  if (limit.nextResetTime !== null) {
    // A five-hour reset cannot be ten hours away; Z.ai sometimes reports it
    // in the wrong timezone, and a bad reset time is worse than none.
    const plausible =
      limit.type === "TIME_LIMIT" || minutes !== 300 || limit.nextResetTime <= nowMs + FIVE_HOURS_MS + 60_000;
    if (plausible) resetsAt = new Date(limit.nextResetTime).toISOString();
  }
  return { label: windowLabel(limit), usedPercent: usedPercent(limit), resetsAt };
}

// Z.ai answers a revoked key with HTTP 200 and this envelope, so the status
// code alone cannot tell a dead key from a transient failure. Only the observed
// failure is treated as a key problem; anything unseen stays a generic error.
const ZAI_AUTH_FAILURE_CODE = 1000;
const ZAI_AUTH_FAILURE_MSG = "authentication failed";

export function classifyZaiEnvelope(body: unknown): "unauthenticated" | "error" | null {
  if (!isRecord(body)) return "error";
  if (body.success === true && body.code === 200) return null;
  const msg = typeof body.msg === "string" ? body.msg.trim().toLowerCase() : "";
  if (Number(body.code) === ZAI_AUTH_FAILURE_CODE || msg === ZAI_AUTH_FAILURE_MSG) {
    return "unauthenticated";
  }
  return "error";
}

export function normalizeZaiQuota(body: unknown, nowMs: number): RawUsageProvider {
  if (!isRecord(body) || body.success !== true || body.code !== 200) {
    throw new Error("Z.ai quota response was not successful");
  }
  const data = body.data;
  if (!isRecord(data) || !Array.isArray(data.limits)) {
    throw new Error("Z.ai quota response has no limits");
  }
  const limits = data.limits.map(parseLimit).filter((limit): limit is ZaiLimit => limit !== null);
  const quota = limits
    .filter((limit) => limit.type !== "TIME_LIMIT")
    .sort((a, b) => (windowMinutes(a) ?? Infinity) - (windowMinutes(b) ?? Infinity));
  const mcp = limits.filter((limit) => limit.type === "TIME_LIMIT").at(-1);
  const plan = [data.planName, data.plan, data.plan_type, data.packageName, data.level].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return {
    status: "ok",
    // Z.ai reports the tier in lower case ("pro"); match how the other cards read.
    planLabel: plan ? plan.trim().replace(/^./, (c) => c.toUpperCase()) : null,
    windows: [...quota, ...(mcp ? [mcp] : [])].map((limit) => toWindow(limit, nowMs)),
  };
}

export async function fetchZaiUsage(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
): Promise<RawUsageProvider> {
  if (!apiKey?.trim()) return { status: "unauthenticated" };
  try {
    const response = await fetchImpl(ZAI_QUOTA_URL, {
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(ZAI_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return { status: "unauthenticated" };
    if (!response.ok) return { status: "error" };
    const body: unknown = await response.json();
    const rejected = classifyZaiEnvelope(body);
    if (rejected) return { status: rejected };
    return normalizeZaiQuota(body, clock().getTime());
  } catch {
    return { status: "error" };
  }
}
