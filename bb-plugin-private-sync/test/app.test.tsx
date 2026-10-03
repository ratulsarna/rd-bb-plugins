// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ConfigInput, FolderStatus, rpcContract, SyncStatus } from "../contract";

const machines = [
  { hostId: "server", name: "Server", connected: true },
  { hostId: "mac", name: "Mac", connected: true },
  { hostId: "wsl", name: "WSL", connected: false },
  { hostId: "workstation", name: "Workstation", connected: true },
];
function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  const folders = [
    { id: "assistants", label: "Assistants", paths: ["/home/me/assistants", "/Users/me/assistants", "/home/me/assistants"] },
    { id: "vault", label: "Personal vault", paths: ["/home/me/ObsidianVault", "/Users/me/Vault/ObsidianVault", "/home/me/ObsidianVault"] },
  ].map(({ id, label, paths }): FolderStatus => ({
    id, label, primaryHostId: "server", ignorePaths: ["local-tools", "runtime/state"], headVersion: 3,
    openConflicts: 0, conflicts: [],
    nodes: machines.slice(0, 3).map((machine, index) => ({
      hostId: machine.hostId, path: paths[index]!, phase: index === 2 ? "offline" : "ready", ready: index !== 2,
      ackedVersion: 3, lag: 0, conflicts: 0, error: null, lastSyncAt: null,
    })),
  }));
  return { enabled: false, paused: false, configError: null, folders, ...overrides };
}
function unexpectedRpc(): never { throw new Error("Unexpected RPC call"); }
async function page(initial = status(), handlers: Partial<PluginRpcTestHandlers<typeof rpcContract>> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.navPanels[0]).toMatchObject({ id: "sync", path: "sync" });
  return renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
    pluginId: "private-sync", realtimeConnectionState: "connected",
    rpc: {
      status: () => initial, machineDirectory: () => machines,
      configure: unexpectedRpc, pause: unexpectedRpc, resume: unexpectedRpc,
      sync: unexpectedRpc, resolvePath: unexpectedRpc, ...handlers,
    },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(cleanup);

it("shows the saved physical map while disabled, with connection and primary status separate", async () => {
  const view = await page();
  await view.findByText("Disabled · sync is off");
  const assistants = within(view.getByRole("region", { name: "Assistants" }));
  const vault = within(view.getByRole("region", { name: "Personal vault" }));
  expect(assistants.getAllByText("/home/me/assistants")).toHaveLength(2);
  expect(assistants.getByText("/Users/me/assistants")).toBeTruthy();
  expect(vault.getByText("/Users/me/Vault/ObsidianVault")).toBeTruthy();
  expect(vault.getAllByText("/home/me/ObsidianVault")).toHaveLength(2);
  expect(assistants.getByText("Server · Primary")).toBeTruthy();
  expect(assistants.getAllByText("Connected")).toHaveLength(2);
  expect(assistants.getByText("Offline")).toBeTruthy();
  expect(assistants.getAllByText("Disabled")).toHaveLength(3);
  expect(view.queryByText("Up to date")).toBeNull();
  expect((assistants.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByText("Not mapped · not synced: Workstation.")).toBeTruthy();
  expect(assistants.getByText("runtime/state")).toBeTruthy();
  expect(view.getByText(/Conversations stay on the selected execution machine/)).toBeTruthy();
});

it("shows preserved conflicts alongside ready nodes and does not request an all-machine barrier offline", async () => {
  const initial = status({ enabled: true });
  initial.folders[0]!.openConflicts = 2;
  initial.folders[0]!.conflicts = [{ id: 1, path: "memory.md", conflictPath: "memory.sync-conflict-mac.md", hostId: "mac", kind: "edit-edit", detectedAt: 1 }];
  const sync = vi.fn();
  const view = await page(initial, { sync });
  await view.findByText("Enabled · watching for changes");
  expect(view.getAllByText("Offline · reconcile on reconnect")).toHaveLength(2);
  expect(view.getByText("2 conflicting changes preserved")).toBeTruthy();
  expect(view.getByText("memory.sync-conflict-mac.md")).toBeTruthy();
  expect(view.getByText("Showing the newest 1 conflicts.")).toBeTruthy();
  fireEvent.click(view.getAllByRole("button", { name: "Sync now" })[0]!);
  expect(sync).not.toHaveBeenCalled();
});

it("roundtrips edits through configure without toggling enabled, and renders the returned map", async () => {
  let saved = status({ enabled: true, paused: true });
  const configure = vi.fn((input: ConfigInput) => {
    saved = { ...saved, folders: saved.folders.map((folder) => {
      const next = input.folders.find((entry) => entry.id === folder.id)!;
      return { ...folder, ...next, ignorePaths: next.ignorePaths ?? [], nodes: folder.nodes.map((node) => ({ ...node, ...next.nodes.find((entry) => entry.hostId === node.hostId)! })) } as FolderStatus;
    }) };
    return saved;
  });
  const view = await page(saved, { configure, status: () => saved });
  await view.findByText("Enabled · paused");
  fireEvent.click(view.getByRole("button", { name: "Edit folder mapping" }));
  const editor = within(view.getByRole("region", { name: "Edit Assistants" }));
  fireEvent.change(editor.getByLabelText("Mac path"), { target: { value: "/Users/me/shared-assistants" } });
  fireEvent.change(editor.getByLabelText("Excluded paths"), { target: { value: "runtime\n\n local-secrets \n" } });
  fireEvent.click(view.getByRole("button", { name: "Save mapping" }));
  await view.findByText("Mapping saved. The enabled and paused settings were kept.");
  expect(configure).toHaveBeenCalledTimes(1);
  const input = configure.mock.calls[0]![0];
  expect(input).not.toHaveProperty("enabled");
  expect(input.folders[0]).toEqual({
    id: "assistants", label: "Assistants", primaryHostId: "server",
    ignorePaths: ["runtime", "local-secrets"],
    nodes: [{ hostId: "server", path: "/home/me/assistants" }, { hostId: "mac", path: "/Users/me/shared-assistants" }, { hostId: "wsl", path: "/home/me/assistants" }],
  });
  expect(input.folders[1]).toMatchObject({ id: "vault", primaryHostId: "server", ignorePaths: ["local-tools", "runtime/state"] });
  expect(view.queryByRole("form", { name: "Edit folder mapping" })).toBeNull();
  expect(view.getByText("/Users/me/shared-assistants")).toBeTruthy();
  expect(view.getByText("Enabled · paused")).toBeTruthy();
});

it("retains rejected draft edits and blocks duplicate writes until a request settles", async () => {
  const write = deferred<SyncStatus>();
  const configure = vi.fn((_input: ConfigInput) => write.promise);
  const view = await page(status(), { configure });
  await view.findByText("Disabled · sync is off");
  fireEvent.click(view.getByRole("button", { name: "Edit folder mapping" }));
  const input = within(view.getByRole("region", { name: "Edit Assistants" })).getByLabelText("Mac path") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "/Users/me/rejected-path" } });
  const form = view.getByRole("form", { name: "Edit folder mapping" });
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(configure).toHaveBeenCalledTimes(1);
  await act(async () => write.reject(new Error("Settings write rejected")));
  await view.findByRole("alert");
  expect(view.getByRole("alert").textContent).toContain("Settings write rejected");
  expect(input.value).toBe("/Users/me/rejected-path");
  expect(view.queryByText(/Mapping saved/)).toBeNull();
  expect(view.getByText("/Users/me/assistants")).toBeTruthy();
  expect(view.getByText("Disabled · sync is off")).toBeTruthy();
});

it("enables a paused map without claiming to start it, then resumes through the pause RPC", async () => {
  let saved = status({ paused: true });
  const write = deferred<SyncStatus>();
  const configure = vi.fn((_input: ConfigInput) => write.promise);
  const resume = vi.fn(() => { saved = { ...saved, paused: false }; return saved; });
  const pause = vi.fn(() => { saved = { ...saved, paused: true }; return saved; });
  const view = await page(saved, { configure, resume, pause, status: () => saved });
  await view.findByText("Disabled · sync is off");
  const button = view.getByRole("button", { name: "Enable sync" });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(configure).toHaveBeenCalledTimes(1);
  expect(configure.mock.calls[0]![0]).toMatchObject({ enabled: true, folders: [{ id: "assistants", primaryHostId: "server" }, { id: "vault", primaryHostId: "server" }] });
  expect(view.queryByRole("button", { name: "Resume" })).toBeNull();
  saved = { ...saved, enabled: true };
  await act(async () => write.resolve(saved));
  await view.findByText("Sync enabled; still paused. Choose Resume to start.");
  expect(resume).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Resume" }));
  await view.findByText("Enabled · watching for changes");
  fireEvent.click(view.getByRole("button", { name: "Pause" }));
  await view.findByText("Enabled · paused");
  expect(resume).toHaveBeenCalledTimes(1);
  expect(pause).toHaveBeenCalledTimes(1);
});

it("refreshes status and connectivity on realtime reconnect without overwriting an open draft", async () => {
  let saved = status();
  let directory = machines;
  const view = await page(saved, { status: () => saved, machineDirectory: () => directory });
  await view.findByText("Disabled · sync is off");
  fireEvent.click(view.getByRole("button", { name: "Edit folder mapping" }));
  const input = within(view.getByRole("region", { name: "Edit Assistants" })).getByLabelText("Mac path") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "/Users/me/draft" } });
  await view.behavior.setRealtimeConnectionState("reconnecting");
  expect((view.getByRole("button", { name: "Save mapping" }) as HTMLButtonElement).closest("fieldset")!.disabled).toBe(true);
  saved = status({ enabled: true, paused: true });
  directory = machines.map((machine) => ({ ...machine, connected: true }));
  await view.behavior.setRealtimeConnectionState("connected");
  await view.findByText("Enabled · paused");
  expect(input.value).toBe("/Users/me/draft");
  expect(view.getAllByText("Connected")).toHaveLength(6);
});

it("does not mislabel failed initial reads as an empty map, and allows recovery", async () => {
  let fail = true;
  const view = await page(status(), {
    status: () => { if (fail) throw new Error("Status unavailable"); return status(); },
    machineDirectory: () => { if (fail) throw new Error("Machine directory unavailable"); return machines; },
  });
  await view.findByText("Sync status is unavailable.");
  expect(view.getAllByRole("alert")).toHaveLength(2);
  expect(view.queryByText(/No folders mapped/)).toBeNull();
  expect(view.queryByRole("button", { name: "Enable sync" })).toBeNull();
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Refresh status" }));
  await view.findByText("Disabled · sync is off");
  await waitFor(() => expect(view.queryAllByRole("alert")).toHaveLength(0));
});

it("creates the canonical Assistants map from an empty setup without enabling sync", async () => {
  const initial = status({ folders: [] });
  const configure = vi.fn((_input: ConfigInput) => initial);
  const view = await page(initial, { configure });
  await view.findByText(/No folders mapped/);
  expect((view.getByRole("button", { name: "Enable sync" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Edit folder mapping" }));
  fireEvent.click(view.getByRole("button", { name: "Add Assistants" }));
  const editor = within(view.getByRole("region", { name: "Edit Assistants" }));
  fireEvent.change(editor.getByLabelText("Add a machine"), { target: { value: "server" } });
  fireEvent.change(editor.getByLabelText("Server path"), { target: { value: "/home/me/assistants" } });
  fireEvent.change(editor.getByLabelText("Primary machine"), { target: { value: "server" } });
  fireEvent.click(view.getByRole("button", { name: "Save mapping" }));
  await view.findByText(/Mapping saved/);
  expect(configure.mock.calls[0]![0]).toEqual({ folders: [{
    id: "assistants", label: "Assistants", primaryHostId: "server", ignorePaths: [],
    nodes: [{ hostId: "server", path: "/home/me/assistants" }],
  }] });
});

it("keeps the returned mutation status when an older realtime read finishes afterward", async () => {
  const oldRead = deferred<SyncStatus>();
  let readCount = 0;
  const initial = status();
  const view = await page(initial, {
    status: () => ++readCount === 1 ? initial : oldRead.promise,
    configure: () => status({ enabled: true }),
  });
  await view.findByText("Disabled · sync is off");
  await view.behavior.emitRealtime("status-changed", {});
  fireEvent.click(view.getByRole("button", { name: "Enable sync" }));
  await view.findByText("Enabled · watching for changes");
  await act(async () => oldRead.resolve(initial));
  expect(view.getByText("Enabled · watching for changes")).toBeTruthy();
  expect(view.queryByText("Disabled · sync is off")).toBeNull();
});

it("does not offer to overwrite an invalid map as if it were an empty setup", async () => {
  const configure = vi.fn();
  const view = await page(status({ enabled: true, configError: "Invalid stored folders", folders: [] }), { configure });
  await view.findByText("Configuration needs attention");
  expect(view.getByText("Sync cannot use the saved folder map. No folders are syncing.")).toBeTruthy();
  expect(view.queryByText(/No folders mapped/)).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Edit folder mapping" }));
  fireEvent.click(view.getByRole("button", { name: "Disable sync" }));
  expect(view.queryByRole("form", { name: "Edit folder mapping" })).toBeNull();
  expect(configure).not.toHaveBeenCalled();
});
