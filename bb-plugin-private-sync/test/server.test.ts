import Database from "better-sqlite3";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import type { FolderStatus, SyncStatus } from "../contract";
import plugin from "../server";
import { Store } from "../lib/store";
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

async function loadPlugin(machines: Machine[], settings?: Record<string, string | boolean>) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "private-sync",
    settings,
    dataDir: join(base, "server"),
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () =>
          machines.map((m) =>
            makeHostResponse({
              id: m.id,
              status: m.online ? "connected" : "disconnected",
              type: "persistent",
            }),
          ),
      },
      system: {
        config: async () => ({ primaryHostId: machines[0]!.id }) as never,
      },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      const target = machines.find((m) => m.id === hostId)!;
      await target.before?.(method, input);
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
  return Object.assign(harness, { testStore: new Store(bb.storage.database()), testDatabase: bb.storage.database() });
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

it("disables a saved map after a machine is removed, retaining settings and pause while enabling still validates", async () => {
  const a = await machine(base, "a");
  const b = await machine(base, "b");
  const machines = [a, b];
  const harness = await loadPlugin(machines);
  const folders = [{ id: "notes", label: "Notes", primaryHostId: a.id, nodes: machines.map((m) => ({ hostId: m.id, path: m.root })), ignorePaths: [] }];
  await put(a, "keep", "synced");
  await harness.behavior.callRpc("configure", { enabled: true, folders });
  await harness.behavior.callRpc("sync", { folderId: "notes" });
  await harness.behavior.callRpc("pause", null);
  machines.pop();
  const transfer = vi.fn();
  a.before = b.before = transfer;
  const disabled = await harness.behavior.callRpc("setEnabled", { enabled: false }) as SyncStatus;
  expect(disabled.enabled).toBe(false);
  expect(disabled.paused).toBe(true);
  expect(disabled.folders[0]!.nodes.map(({ hostId, path }) => ({ hostId, path }))).toEqual(folders[0]!.nodes);
  await expect(harness.behavior.callRpc("setEnabled", { enabled: true })).rejects.toThrow(/unknown machine/);
  await expect(harness.behavior.callRpc("configure", { enabled: false, folders })).rejects.toThrow(/unknown machine/);
  await put(a, "keep", "after disabling");
  await harness.behavior.callRpc("resume", null);
  await expect(harness.behavior.callRpc("sync", { folderId: "notes" })).rejects.toThrow(/not running/);
  expect((await harness.behavior.callRpc("status", null) as SyncStatus).enabled).toBe(false);
  expect(transfer.mock.calls.filter(([method]) => ["scan", "read", "write", "remove", "link"].includes(method))).toEqual([]);
  expect(await read(b, "keep")).toBe("synced");
  const cli = await harness.behavior.runCli(["disable", "--json"]);
  expect(JSON.parse(cli.stdout!).enabled).toBe(false);
});

it("can disable malformed saved settings without replacing them or enabling them", async () => {
  const a = await machine(base, "a");
  const harness = await loadPlugin([a], { enabled: true, folders: "not json" });
  const disabled = await harness.behavior.callRpc("setEnabled", { enabled: false }) as SyncStatus;
  expect(disabled).toMatchObject({ enabled: false, configError: "The folders setting is not valid JSON" });
  await expect(harness.behavior.callRpc("setEnabled", { enabled: true })).rejects.toThrow(/not valid JSON/);
  expect(await harness.behavior.callRpc("status", null)).toMatchObject({ enabled: false, configError: disabled.configError });
});

it("acknowledges conflicts through factory RPC/CLI without changing files, persists counts, and closes no-copy rows on original deletion", async () => {
  const a = await machine(base, "a");
  const b = await machine(base, "b");
  const harness = await loadPlugin([a, b]);
  await put(a, "doc", "restored edit");
  await put(a, "keep", "sentinel");
  await harness.behavior.callRpc("configure", { enabled: true, folders: [{
    id: "notes", label: "Notes", nodes: [a, b].map((m) => ({ hostId: m.id, path: m.root })),
  }] });
  await harness.behavior.callRpc("sync", { folderId: "notes" });
  await harness.behavior.callRpc("pause", null);
  const store = harness.testStore;
  for (let i = 0; i < 3; i++) store.addConflict("notes", { path: "doc", conflictPath: null, kind: "delete-edit", hostId: b.id, detectedAt: i });
  const [first, second, third] = store.openConflicts("notes", 50).conflicts;
  const head = store.head("notes");
  expect((await harness.behavior.callRpc("resolveConflict", { folderId: "other", id: first!.id }) as SyncStatus).folders[0]!.openConflicts).toBe(3);
  expect((await harness.behavior.callRpc("resolveConflict", { folderId: "notes", id: 99999 }) as SyncStatus).folders[0]!.openConflicts).toBe(3);
  for (let i = 0; i < 2; i++) {
    const resolved = await harness.behavior.callRpc("resolveConflict", { folderId: "notes", id: first!.id }) as SyncStatus;
    expect(resolved.folders[0]!.openConflicts).toBe(2);
    expect(resolved.folders[0]!.nodes.find((node) => node.hostId === b.id)!.conflicts).toBe(2);
  }
  const cli = await harness.behavior.runCli(["resolve", "--folder", "notes", "--id", String(second!.id), "--json"]);
  expect(JSON.parse(cli.stdout!).folders[0].openConflicts).toBe(1);
  const db = new Database(harness.testDatabase.name);
  try {
    const reopened = new Store(db);
    expect(reopened.openConflicts("notes", 50)).toMatchObject({ total: 1, conflicts: [third] });
    expect(reopened.openConflicts("notes", 50).byHost.get(b.id)).toBe(1);
  } finally { db.close(); }
  expect(store.head("notes")).toEqual(head);
  expect(await read(a, "doc")).toBe("restored edit");
  expect(await read(b, "doc")).toBe("restored edit");
  await unlink(join(a.root, "doc"));
  await harness.behavior.callRpc("resume", null);
  const synced = await harness.behavior.callRpc("sync", { folderId: "notes" }) as FolderStatus;
  expect(synced.openConflicts).toBe(0);
  expect(synced.nodes.every((node) => node.conflicts === 0)).toBe(true);
  expect(await read(b, "doc")).toBeNull();
  expect(await read(b, "keep")).toBe("sentinel");
});
