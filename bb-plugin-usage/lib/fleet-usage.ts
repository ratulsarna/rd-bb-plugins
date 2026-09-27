import {
  fetchUsageLimits,
  type RawUsageResponse,
  type RawUsageSnapshot,
} from "./usage";

interface Host {
  id: string;
  name: string;
  status: string;
  lifecycle: { phase: string };
}

export async function fetchFleetUsage(options: {
  listHosts: () => Promise<Host[]>;
  getPrimaryHostId: () => Promise<string | null>;
  usageLimits: (args: {
    hostId: string;
    providerId?: string;
    signal: AbortSignal;
  }) => Promise<RawUsageResponse>;
}): Promise<RawUsageSnapshot> {
  const [hosts, primaryHostId] = await Promise.all([
    options.listHosts(),
    options.getPrimaryHostId(),
  ]);
  const results = await Promise.all(
    hosts
      .filter((host) => host.lifecycle.phase !== "destroyed")
      .map(async (host) => {
        const primary = host.id === primaryHostId;
        let providers: RawUsageResponse;
        if (host.status !== "connected") {
          providers = {
            codex: { status: "offline" },
            "claude-code": { status: "offline" },
          };
        } else {
          try {
            providers = await fetchUsageLimits(({ signal }) =>
              options.usageLimits({
                hostId: host.id,
                ...(primary ? {} : { providerId: "claude-code" }),
                signal,
              }),
            );
          } catch {
            providers = {
              codex: { status: "error" },
              "claude-code": { status: "error" },
            };
          }
        }
        return {
          primary,
          providers,
          machine: {
            id: host.id,
            name: host.name,
            primary,
            usage: providers["claude-code"] ?? { status: "not_installed" },
          },
        };
      }),
  );
  return {
    providers: results.find((result) => result.primary)?.providers ?? {
      codex: { status: "error" },
    },
    claudeMachines: results.map((result) => result.machine),
  };
}
