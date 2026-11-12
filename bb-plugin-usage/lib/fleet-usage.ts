import {
  fetchUsageLimits,
  USAGE_REQUEST_TIMEOUT_MS,
  type RawClaudeMachine,
  type RawUsageProvider,
  type RawUsageResponse,
  type RawUsageSnapshot,
} from "./usage";

interface Host {
  id: string;
  name: string;
  status: string;
  lifecycle: { phase: string };
}

/** bb's Claude Code health on one machine: its login, read without a usage call. */
export interface ClaudeHealth {
  status: string;
  accountEmail?: string | null;
}

/** Health that already says what the card shows, so no usage call is needed. */
const SETTLED_BY_HEALTH: Record<string, string> = {
  not_installed: "not_installed",
  unauthenticated: "unauthenticated",
  expired: "expired",
};

const OFFLINE: RawUsageResponse = {
  codex: { status: "offline" },
  "claude-code": { status: "offline" },
};
const FAILED: RawUsageResponse = {
  codex: { status: "error" },
  "claude-code": { status: "error" },
};

const emailOf = (value: string | null | undefined) =>
  value?.trim().toLowerCase() || null;
const claudeOf = (providers: RawUsageResponse): RawUsageProvider =>
  providers["claude-code"] ?? { status: "not_installed" };

/**
 * Anthropic rate-limits usage reads per login, so each Claude account is read on one machine:
 * the primary first, then the account's other machines in turn until one reads. Health groups
 * the machines by account email; a machine whose health says nothing useful is read on its own.
 */
export async function fetchFleetUsage(options: {
  listHosts: () => Promise<Host[]>;
  getPrimaryHostId: () => Promise<string | null>;
  usageLimits: (args: {
    hostId: string;
    providerId?: string;
    signal: AbortSignal;
  }) => Promise<RawUsageResponse>;
  claudeHealth: (args: {
    hostId: string;
    signal: AbortSignal;
  }) => Promise<ClaudeHealth | null>;
}): Promise<RawUsageSnapshot> {
  const [hosts, primaryHostId] = await Promise.all([
    options.listHosts(),
    options.getPrimaryHostId(),
  ]);
  const live = hosts.filter((host) => host.lifecycle.phase !== "destroyed");
  const primaryHost = live.find((host) => host.id === primaryHostId);

  const readUsage = async (host: Host): Promise<RawUsageResponse> => {
    if (host.status !== "connected") return OFFLINE;
    try {
      return await fetchUsageLimits(({ signal }) =>
        options.usageLimits({
          hostId: host.id,
          ...(host === primaryHost ? {} : { providerId: "claude-code" }),
          signal,
        }),
      );
    } catch {
      return FAILED;
    }
  };
  const readHealth = (host: Host): Promise<ClaudeHealth | null> =>
    options
      .claudeHealth({
        hostId: host.id,
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      })
      .catch(() => null);

  const others = live.filter((host) => host !== primaryHost);
  const [providers, healths] = await Promise.all([
    primaryHost ? readUsage(primaryHost) : undefined,
    Promise.all(
      others.map((host) =>
        host.status === "connected" ? readHealth(host) : null,
      ),
    ),
  ]);

  const usage = new Map<Host, RawUsageProvider>();
  const readings = new Map<string, RawUsageProvider>();
  if (primaryHost && providers) {
    const reading = claudeOf(providers);
    usage.set(primaryHost, reading);
    const email = emailOf(reading.accountEmail);
    if (reading.status === "ok" && email) readings.set(email, reading);
  }

  const groups = new Map<string, Host[]>();
  const alone: Host[] = [];
  others.forEach((host, k) => {
    const health = healths[k];
    if (host.status !== "connected") {
      usage.set(host, claudeOf(OFFLINE));
      return;
    }
    const settled = health && SETTLED_BY_HEALTH[health.status];
    if (settled) {
      usage.set(host, { status: settled, accountEmail: health.accountEmail ?? null });
      return;
    }
    const email = health?.status === "ready" ? emailOf(health.accountEmail) : null;
    if (!email) {
      alone.push(host);
      return;
    }
    groups.set(email, [...(groups.get(email) ?? []), host]);
  });

  await Promise.all([
    ...alone.map(async (host) => {
      usage.set(host, claudeOf(await readUsage(host)));
    }),
    ...[...groups].map(async ([email, members]) => {
      for (const host of members) {
        const known = readings.get(email);
        if (known) {
          usage.set(host, known);
          continue;
        }
        const read = claudeOf(await readUsage(host));
        // A failed read may name no account; health did, so the machine stays on its card.
        const reading = read.accountEmail ? read : { ...read, accountEmail: email };
        usage.set(host, reading);
        if (reading.status === "ok") readings.set(email, reading);
      }
    }),
  ]);

  return {
    providers: providers ?? { codex: { status: "error" } },
    claudeMachines: live.map(
      (host): RawClaudeMachine => ({
        id: host.id,
        name: host.name,
        primary: host === primaryHost,
        usage: usage.get(host)!,
      }),
    ),
  };
}
