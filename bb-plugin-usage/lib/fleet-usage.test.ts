import { describe, expect, it, vi } from "vitest";
import { fetchFleetUsage } from "./fleet-usage";
import {
  createUsageService,
  normalizeUsage,
  type RawClaudeMachine,
} from "./usage";

const host = (id: string, status = "connected", phase = "active") => ({
  id,
  name: id,
  status,
  lifecycle: { phase },
});
const machine = (
  id: string,
  usage: RawClaudeMachine["usage"],
): RawClaudeMachine => ({
  id,
  name: id,
  primary: id === "server",
  usage,
});
const healthy = (
  accountKey?: string,
  accountEmail: string | null = "a@example.com",
) => ({
  status: "ok",
  accountKey,
  accountEmail,
  windows: [{ label: "Weekly", usedPercent: 20, resetsAt: null }],
});
const accounts = (claudeMachines: RawClaudeMachine[]) =>
  normalizeUsage({ providers: {}, claudeMachines }).providers.claudeCode;

describe("Claude accounts across machines", () => {
  it("groups by account key, prefers a working machine, and never sums quota", () => {
    const result = accounts([
      machine("absent", { status: "not_installed" }),
      machine("expired", { status: "expired", accountKey: "a" }),
      machine("server", healthy("a")),
      machine("laptop", {
        ...healthy("a"),
        windows: [{ label: "Weekly", usedPercent: 25, resetsAt: null }],
      }),
      machine("other", healthy("b", "b@example.com")),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      status: "ok",
      windows: [{ remainingPercent: 80 }],
    });
    expect(result[0]!.machines.map((m) => m.id)).toEqual([
      "expired",
      "server",
      "laptop",
    ]);
    expect(result[1]!.accountEmail).toBe("b@example.com");
  });

  it("joins keyless readings by normalized email without merging distinct known keys", () => {
    const result = accounts([
      machine("legacy", healthy(undefined, " A@EXAMPLE.COM ")),
      machine("current", healthy("a")),
      machine("unknown1", healthy(undefined, null)),
      machine("unknown2", healthy(undefined, null)),
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]!.machines.map((m) => m.id)).toEqual(["legacy", "current"]);
    expect(
      accounts([
        machine("a", healthy("a")),
        machine("b", healthy("b")),
        machine("ambiguous", healthy()),
      ]),
    ).toHaveLength(3);
  });

  it("isolates transport and offline failures and ignores destroyed machines", async () => {
    const usageLimits = vi.fn(async ({ hostId }: { hostId: string }) => {
      if (hostId === "broken") throw new Error("private transport error");
      return { codex: healthy("codex"), "claude-code": healthy(hostId) };
    });
    const result = await fetchFleetUsage({
      listHosts: async () => [
        host("server"),
        host("remote"),
        host("broken"),
        host("offline", "disconnected"),
        host("gone", "connected", "destroyed"),
      ],
      getPrimaryHostId: async () => "server",
      usageLimits,
    });
    expect(usageLimits.mock.calls.map(([args]) => args)).toEqual([
      { hostId: "server", signal: expect.any(AbortSignal) },
      {
        hostId: "remote",
        providerId: "claude-code",
        signal: expect.any(AbortSignal),
      },
      {
        hostId: "broken",
        providerId: "claude-code",
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(result.providers.codex?.status).toBe("ok");
    expect(result.claudeMachines.map((m) => m.usage.status)).toEqual([
      "ok",
      "ok",
      "error",
      "offline",
    ]);
    expect(JSON.stringify(result)).not.toContain("private transport error");
  });

  it("rebuilds account groups after login changes and never runs local recovery for a remote login", async () => {
    let swapped = false;
    const recoverClaudeCredentials = vi.fn();
    const service = createUsageService({
      fetchUsage: async () => ({
        providers: {},
        claudeMachines: [
          machine("server", healthy("a")),
          machine(
            "laptop",
            swapped
              ? {
                  status: "expired",
                  accountKey: "b",
                  accountEmail: "b@example.com",
                }
              : healthy("a"),
          ),
        ],
      }),
      recoverClaudeCredentials,
      publishUsageUpdated: vi.fn(),
    });
    expect((await service.getUsage({})).providers.claudeCode).toHaveLength(1);
    swapped = true;
    const result = await service.getUsage({ refresh: true });
    expect(result.providers.claudeCode).toHaveLength(2);
    expect(result.providers.claudeCode[0]!.machines.map((m) => m.id)).toEqual([
      "server",
    ]);
    expect(result.providers.claudeCode[1]).toMatchObject({
      accountEmail: "b@example.com",
      status: "expired",
    });
    expect(recoverClaudeCredentials).not.toHaveBeenCalled();
  });
});
