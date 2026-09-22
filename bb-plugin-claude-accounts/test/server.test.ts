import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const host = (
  id: string,
  status: "connected" | "disconnected" = "connected",
) => ({
  id,
  name: id,
  status,
  type: "persistent" as const,
  machineProviderId: "manual",
  maxPermissionMode: "full" as const,
  createdAt: 0,
  updatedAt: 0,
  lastSeenAt: 0,
  lastRejectedProtocolVersion: null,
  providerDetails: null,
  lifecycle: {
    phase: "active" as const,
    message: null,
    pendingLog: "",
    suspendedAt: null,
    teardown: null,
  },
});
const login = {
  id: "login-1",
  phase: "starting",
  url: null,
  message: "Starting...",
  expiresAt: Date.now() + 60_000,
};
describe("multi-machine switching", () => {
  it("keeps successes when another machine fails, deduplicates hosts, and never dispatches to offline hosts", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "claude-accounts",
      experimental_hostEntry: true,
      sdk: {
        hosts: {
          get: async ({ hostId }) =>
            host(hostId, hostId === "offline" ? "disconnected" : "connected"),
        },
      },
      experimental_callHostRpc: async ({ hostId }) => {
        if (hostId === "broken") throw new Error("private host error");
        return login;
      },
    });
    plugin(bb);
    const result = (await harness.behavior.callRpc("start", {
      hostIds: ["ok", "ok", "broken", "offline"],
    })) as { hostId: string; login: unknown; error: string | null }[];
    expect(result).toHaveLength(3);
    expect(result[0].login).toEqual(login);
    expect(result.slice(1).every((item) => item.error !== null)).toBe(true);
    expect(
      harness.inspection.experimental_hostRpcCalls.map((call) => call.hostId),
    ).toEqual(["ok", "broken"]);
    expect(JSON.stringify(result)).not.toContain("private host error");
    await harness.lifecycle.dispose();
  });
  it("preserves an offline machine in the list and does not run logins during discovery", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "claude-accounts",
      experimental_hostEntry: true,
      sdk: {
        hosts: {
          list: async () => [host("ready"), host("offline", "disconnected")],
        },
      },
      experimental_callHostRpc: async () => ({
        available: true,
        identity: null,
        issue: null,
        login: null,
      }),
    });
    plugin(bb);
    const result = (await harness.behavior.callRpc("list", {
      refresh: true,
    })) as { machines: { hostId: string; connected: boolean }[] };
    expect(
      result.machines.map((machine) => [machine.hostId, machine.connected]),
    ).toEqual([
      ["ready", true],
      ["offline", false],
    ]);
    expect(
      harness.inspection.experimental_hostRpcCalls.map((call) => call.method),
    ).toEqual(["inspect"]);
    await expect(
      harness.behavior.callRpc("submit", {
        hostId: "ready",
        id: "x",
        code: "one\ntwo",
      }),
    ).rejects.toThrow();
    await harness.lifecycle.dispose();
  });
  it("uses only public SDK imports", () => {
    const scan = experimental_scanPublicSdkOnly(
      fileURLToPath(new URL("..", import.meta.url)),
      {
        allow: [
          /^react$/,
          /^@radix-ui\/react-slot$/,
          /^class-variance-authority$/,
          /^clsx$/,
          /^tailwind-merge$/,
          /^@testing-library\/react$/,
          /^vitest\/config$/,
        ],
      },
    );
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
