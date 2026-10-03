import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import type { FolderStatus, SyncStatus } from "../contract";
import plugin from "../server";
import { cleanup, machine, put, read, tempDir, type Machine } from "./helpers";

let base: string;
let stop: (() => Promise<void>) | null = null;

beforeEach(async () => {
  base = await tempDir();
});
afterEach(async () => {
  await stop?.();
  stop = null;
  await cleanup(base);
});

async function loadPlugin(machines: Machine[]) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "private-sync",
    dataDir: join(base, "server"),
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () =>
          machines.map((m) =>
            makeHostResponse({
              id: m.id,
              status: "connected",
              type: "persistent",
            }),
          ),
      },
      system: {
        config: async () => ({ primaryHostId: machines[0]!.id }) as never,
      },
    },
    experimental_callHostRpc: ({ method, input, hostId }) => {
      const target = machines.find((m) => m.id === hostId)!;
      return (
        target.harness.experimental_call as (
          m: string,
          i: unknown,
        ) => Promise<unknown>
      )(method, input);
    },
  });
  await plugin(bb);
  const service = harness.behavior.runService("sync");
  stop = async () => {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  };
  return harness;
}

it("applies configure before answering and keeps barriers alive across no-op saves", async () => {
  const machines = [
    await machine(base, "host-a"),
    await machine(base, "host-b"),
  ];
  const [a, b] = machines as [Machine, Machine];
  const harness = await loadPlugin(machines);
  const config = {
    enabled: true,
    folders: [
      {
        id: "notes",
        label: "Notes",
        nodes: machines.map((m) => ({ hostId: m.id, path: m.root })),
      },
    ],
  };

  const configured = (await harness.behavior.callRpc(
    "configure",
    config,
  )) as SyncStatus;
  expect(configured.enabled).toBe(true);
  expect(
    configured.folders.map((folder) => [folder.id, folder.primaryHostId]),
  ).toEqual([["notes", "host-a"]]);

  await put(a, "hello.md", "hi");
  const barrier = harness.behavior.callRpc("sync", {
    folderId: "notes",
  }) as Promise<FolderStatus>;
  // Saving the same config again must not restart sync or cancel the barrier.
  await harness.behavior.callRpc("configure", config);
  const synced = await barrier;
  expect(synced.nodes.every((node) => node.ready)).toBe(true);
  expect(await read(b, "hello.md")).toBe("hi");

  const cli = await harness.behavior.runCli(["status", "--json"]);
  expect(JSON.parse(cli.stdout ?? "").folders[0].nodes).toHaveLength(2);

  const paused = (await harness.behavior.callRpc("pause", null)) as SyncStatus;
  expect(paused.paused).toBe(true);
  expect(paused.folders[0]!.nodes.map((node) => node.phase)).toEqual([
    "paused",
    "paused",
  ]);
  await expect(
    harness.behavior.callRpc("sync", { folderId: "notes" }),
  ).rejects.toThrow(/paused/);

  const directory = await harness.behavior.callRpc("machineDirectory", null);
  expect(directory).toMatchObject([
    { hostId: a.id, connected: true },
    { hostId: b.id, connected: true },
  ]);
  await harness.behavior.callRpc("configure", {
    enabled: true,
    folders: [{ ...config.folders[0], id: "assistants" }],
  });
  const context = (path: string) => makePluginAgentConfigurationContext({
    host: { id: b.id, name: "Machine B" },
    environment: { path },
  });
  const configuredAgent = await harness.behavior.resolveAgentConfiguration(
    context(join(b.root, "sam")),
  );
  expect(configuredAgent.instructions).toContain('Current machine: "Machine B" (host-b)');
  expect(configuredAgent.instructions).toContain(`Assistants root: ${JSON.stringify(b.root)}`);
  expect(configuredAgent.instructions).toContain("Personal vault: null");
  expect(configuredAgent.instructions).not.toContain(a.root);
  const unrelatedAgent = await harness.behavior.resolveAgentConfiguration(
    context(`${b.root}-other/sam`),
  );
  expect(unrelatedAgent.instructions ?? "").not.toContain("Assistants root:");
});
