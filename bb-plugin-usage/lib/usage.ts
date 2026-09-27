import { calculatePace, type Clock, type Pace, type ProviderId } from "./pace";

export type ProviderStatus =
  "ok" | "not_installed" | "unauthenticated" | "expired" | "error" | "offline";

export interface UsageWindow {
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
  pace: Pace | null;
}

export interface UsageProvider {
  id: ProviderId;
  name: "Codex" | "Claude Code" | "Z.ai";
  status: ProviderStatus;
  accountEmail: string | null;
  planLabel: string | null;
  windows: UsageWindow[];
}

export interface UsageMachine {
  id: string;
  name: string;
  status: ProviderStatus;
}

export interface ClaudeAccount extends UsageProvider {
  id: "claudeCode";
  name: "Claude Code";
  accountId: string;
  machines: UsageMachine[];
}

export interface RawClaudeMachine {
  id: string;
  name: string;
  primary: boolean;
  usage: RawUsageProvider;
}

export interface RawUsageSnapshot {
  providers: RawUsageResponse;
  claudeMachines: RawClaudeMachine[];
}

export interface UsageResponse {
  fetchedAt: string;
  providers: {
    codex: UsageProvider & { id: "codex"; name: "Codex" };
    claudeCode: ClaudeAccount[];
    zai: UsageProvider & { id: "zai"; name: "Z.ai" };
  };
}

export interface RawUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface RawUsageProvider {
  status: string;
  accountKey?: string | null;
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
  zai: "Z.ai",
} as const;

const PROVIDER_STATUSES = new Set<ProviderStatus>([
  "ok",
  "not_installed",
  "unauthenticated",
  "expired",
  "error",
  "offline",
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
  snapshot: RawUsageSnapshot,
  clock: Clock = () => new Date(),
): UsageResponse {
  const now = clock();
  const fixedClock = () => now;
  const raw = snapshot.providers;
  const accounts = new Map<string, ClaudeAccount>();
  // Only use email to join a missing key when it identifies one known account.
  const keysByEmail = new Map<string, Set<string>>();
  for (const { usage } of snapshot.claudeMachines) {
    const email = usage.accountEmail?.trim().toLowerCase();
    if (email && usage.accountKey) {
      const keys = keysByEmail.get(email) ?? new Set<string>();
      keys.add(usage.accountKey);
      keysByEmail.set(email, keys);
    }
  }
  for (const machine of snapshot.claudeMachines) {
    if (machine.usage.status === "not_installed") continue;
    const provider = normalizeProvider("claudeCode", machine.usage, fixedClock);
    const email = provider.accountEmail?.trim().toLowerCase();
    const keys = email ? keysByEmail.get(email) : undefined;
    const key =
      machine.usage.accountKey || (keys?.size === 1 ? [...keys][0] : undefined);
    const accountId = key
      ? `account:${key}`
      : email
        ? `email:${email}`
        : `host:${machine.id}`;
    const previous = accounts.get(accountId);
    const machines = [
      ...(previous?.machines ?? []),
      {
        id: machine.id,
        name: machine.name,
        status: provider.status,
      },
    ];
    // A failed login on one machine must not replace a working quota reading.
    accounts.set(accountId, {
      ...(previous?.status === "ok" ? previous : provider),
      accountId,
      machines,
    });
  }

  return {
    fetchedAt: now.toISOString(),
    providers: {
      codex: normalizeProvider("codex", raw.codex, fixedClock),
      claudeCode: [...accounts.values()],
      zai: normalizeProvider("zai", raw.zai, fixedClock),
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
  fetchUsage: () => Promise<RawUsageSnapshot>;
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
    if (!refresh && cached && nowMs - cached.cachedAtMs < USAGE_CACHE_TTL_MS) {
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
        firstRaw.claudeMachines.some(
          (machine) => machine.primary && machine.usage.status === "expired",
        );

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
