import {
  calculatePace,
  type Clock,
  type Pace,
  type ProviderId,
} from "./pace";

export type ProviderStatus =
  | "ok"
  | "not_installed"
  | "unauthenticated"
  | "expired"
  | "error";

export interface UsageWindow {
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
  pace: Pace | null;
}

export interface UsageProvider {
  id: ProviderId;
  name: "Codex" | "Claude Code";
  status: ProviderStatus;
  accountEmail: string | null;
  planLabel: string | null;
  windows: UsageWindow[];
}

export interface UsageResponse {
  fetchedAt: string;
  providers: {
    codex: UsageProvider & { id: "codex"; name: "Codex" };
    claudeCode: UsageProvider & {
      id: "claudeCode";
      name: "Claude Code";
    };
  };
}

export interface RawUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface RawUsageProvider {
  status: string;
  accountEmail?: string | null;
  planLabel?: string | null;
  windows?: readonly RawUsageWindow[];
}

export type RawUsageResponse = Partial<Record<string, RawUsageProvider>>;

export const USAGE_CACHE_TTL_MS = 60_000;
export const USAGE_REQUEST_TIMEOUT_MS = 35_000;

const PROVIDER_NAMES = {
  codex: "Codex",
  claudeCode: "Claude Code",
} as const;

const PROVIDER_STATUSES = new Set<ProviderStatus>([
  "ok",
  "not_installed",
  "unauthenticated",
  "expired",
  "error",
]);

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export function remainingPercent(usedPercent: number): number {
  const remaining = Math.round(100 - usedPercent);
  if (Number.isNaN(remaining)) return 0;
  if (remaining === Number.POSITIVE_INFINITY) return 100;
  if (remaining === Number.NEGATIVE_INFINITY) return 0;
  return Math.min(100, Math.max(0, remaining));
}

function normalizeResetTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeProvider<Id extends ProviderId>(
  id: Id,
  rawValue: RawUsageProvider | undefined,
  clock: Clock,
): UsageProvider & {
  id: Id;
  name: (typeof PROVIDER_NAMES)[Id];
} {
  const raw = rawValue ?? { status: "not_installed" };
  const status = PROVIDER_STATUSES.has(raw.status as ProviderStatus)
    ? (raw.status as ProviderStatus)
    : "error";
  const windows =
    status === "ok" && Array.isArray(raw.windows)
      ? raw.windows.map((window) => {
          const resetsAt = normalizeResetTime(window.resetsAt);
          return {
            label: window.label,
            remainingPercent: remainingPercent(window.usedPercent),
            resetsAt,
            pace: calculatePace(
              {
                providerId: id,
                label: window.label,
                usedPercent: window.usedPercent,
                resetsAt,
              },
              clock,
            ),
          };
        })
      : [];

  return {
    id,
    name: PROVIDER_NAMES[id],
    status,
    accountEmail: optionalString(raw.accountEmail),
    planLabel: optionalString(raw.planLabel),
    windows,
  };
}

export function normalizeUsage(
  raw: RawUsageResponse,
  clock: Clock = () => new Date(),
): UsageResponse {
  const now = clock();
  const fixedClock = () => now;

  return {
    fetchedAt: now.toISOString(),
    providers: {
      codex: normalizeProvider("codex", raw.codex, fixedClock),
      claudeCode: normalizeProvider(
        "claudeCode",
        raw["claude-code"],
        fixedClock,
      ),
    },
  };
}

export function fetchUsageLimits(
  usageLimits: (args: { signal: AbortSignal }) => Promise<RawUsageResponse>,
  timeoutSignal: (milliseconds: number) => AbortSignal = AbortSignal.timeout,
): Promise<RawUsageResponse> {
  return usageLimits({ signal: timeoutSignal(USAGE_REQUEST_TIMEOUT_MS) });
}

export function createUsageService(options: {
  fetchUsage: () => Promise<RawUsageResponse>;
  recoverClaudeCredentials?: () => Promise<void>;
  publishUsageUpdated: (payload: { fetchedAt: string }) => void;
  clock?: Clock;
}) {
  const clock = options.clock ?? (() => new Date());
  let cached: { value: UsageResponse; cachedAtMs: number } | null = null;
  let inFlight: {
    promise: Promise<UsageResponse>;
    refreshRequested: boolean;
  } | null = null;

  function getUsage(input: { refresh?: boolean }): Promise<UsageResponse> {
    const refresh = input.refresh === true;

    if (inFlight) {
      if (refresh) inFlight.refreshRequested = true;
      return inFlight.promise;
    }

    const nowMs = clock().getTime();
    if (
      !refresh &&
      cached &&
      nowMs - cached.cachedAtMs < USAGE_CACHE_TTL_MS
    ) {
      return Promise.resolve(cached.value);
    }

    const request = {
      promise: Promise.resolve(null as never) as Promise<UsageResponse>,
      refreshRequested: refresh,
    };
    request.promise = options.fetchUsage().then(async (firstRaw) => {
      let raw = firstRaw;
      const shouldRecover =
        request.refreshRequested &&
        firstRaw["claude-code"]?.status === "expired";

      if (shouldRecover) {
        try {
          await options.recoverClaudeCredentials?.();
        } catch {
          // Claude owns its credentials. A failed probe must not hide Codex.
        }

        try {
          raw = await options.fetchUsage();
        } catch {
          raw = firstRaw;
        }
      }

      const value = normalizeUsage(raw, clock);
      if (
        shouldRecover &&
        value.providers.claudeCode.status === "expired" &&
        cached?.value.providers.claudeCode.status === "ok"
      ) {
        throw new Error("Claude Code usage refresh failed");
      }

      cached = { value, cachedAtMs: Date.parse(value.fetchedAt) };
      if (request.refreshRequested) {
        options.publishUsageUpdated({ fetchedAt: value.fetchedAt });
      }
      return value;
    });
    inFlight = request;
    void request.promise.then(
      () => {
        if (inFlight === request) inFlight = null;
      },
      () => {
        if (inFlight === request) inFlight = null;
      },
    );

    return request.promise;
  }

  return { getUsage };
}
