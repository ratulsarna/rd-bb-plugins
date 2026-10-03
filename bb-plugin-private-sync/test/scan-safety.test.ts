import { mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HashCache, scanRoot } from "../lib/host-fs";
import { reconcileNode, type PassRequest } from "../lib/reconcile";
import { cleanup, folderOf, hostClient, machine, openStore, put, read, startCoordinator, tempDir, type Machine } from "./helpers";

let base: string;
beforeEach(async () => { base = await tempDir(); });
afterEach(async () => { vi.restoreAllMocks(); await cleanup(base); });

async function setup() {
  const machines = [await machine(base, "a"), await machine(base, "b")];
  const [a, b] = machines as [Machine, Machine];
  const store = openStore(join(base, "hub.db"));
  const folder = folderOf(machines);
  const request = (node: Machine, scope: PassRequest["scope"] = "all"): PassRequest => ({
    store, folder, host: hostClient(machines), hostId: node.id, root: node.root, scope,
    signal: new AbortController().signal, now: Date.now, sliceMs: 10_000,
    transfers: new Map(), uploads: new Map(),
  });
  await put(a, "a.txt", "first");
  await put(a, "z.txt", "last");
  await reconcileNode(request(a));
  await reconcileNode(request(b));
  return { machines, a, b, store, folder, request };
}

it.each(["move", "replace", "retarget"] as const)("rejects a nonempty %s mid-walk snapshot before cache/head/ack publication", async (change) => {
  for (const scope of ["all", ["a.txt", "z.txt"]] as const) {
    const runBase = base;
    base = join(runBase, String(Array.isArray(scope)));
    await mkdir(base);
    const { a, b, store, request } = await setup();
    const configured = join(base, "configured");
    await symlink(a.root, configured);
    const pass = request(a, scope);
    if (change === "retarget") {
      pass.root = configured;
      store.prepareNode("notes", a.id, configured);
      await reconcileNode(pass);
    }
    const head = store.head("notes");
    const node = store.node("notes", a.id);
    const saved = vi.spyOn(HashCache.prototype, "save");
    const originalHash = HashCache.prototype.hash;
    let changed = false;
    vi.spyOn(HashCache.prototype, "hash").mockImplementation(async function (this: HashCache, path, abs, stats) {
      const result = await originalHash.call(this, path, abs, stats);
      if (!changed && abs === join(a.root, "a.txt")) {
        changed = true;
        if (change === "retarget") {
          const replacement = join(base, "replacement");
          await mkdir(replacement);
          await writeFile(join(replacement, "a.txt"), "unrelated");
          await unlink(configured);
          await symlink(replacement, configured);
        } else {
          await rename(a.root, `${a.root}-moved`);
          if (change === "replace") {
            await mkdir(a.root);
            await writeFile(join(a.root, "a.txt"), "unrelated");
          }
        }
      }
      return result;
    });
    await expect(reconcileNode(pass)).rejects.toThrow(/root changed/);
    expect(changed).toBe(true);
    expect(saved).not.toHaveBeenCalled();
    expect(store.head("notes")).toEqual(head);
    expect(store.node("notes", a.id)).toEqual(node);
    vi.restoreAllMocks();
    await reconcileNode(request(b));
    expect(store.head("notes")).toEqual(head);
    expect(await read(b, "a.txt")).toBe("first");
    expect(await read(b, "z.txt")).toBe("last");
    base = runBase;
  }
});

it("accepts legitimate directory edits that change mtime but not identity", async () => {
  const root = join(base, "root");
  await mkdir(root);
  await writeFile(join(root, "a"), "a");
  const cache = new HashCache(join(base, "cache"));
  const hash = cache.hash.bind(cache);
  vi.spyOn(cache, "hash").mockImplementation(async (...args) => {
    const result = await hash(...args);
    await writeFile(join(root, "new-file"), "edit");
    return result;
  });
  expect((await scanRoot(cache, { root, ignorePaths: [], ownDirs: [] })).ok).toBe(true);
});

it.each(["absolute", "escape"])("an external %s symlink cannot hide a wiped root in a partial scan", async (kind) => {
  const { a, b, store, request } = await setup();
  const head = store.head("notes");
  const node = store.node("notes", a.id);
  await unlink(join(a.root, "a.txt"));
  await unlink(join(a.root, "z.txt"));
  await writeFile(join(base, "outside"), "not mirrored");
  await symlink(kind === "absolute" ? join(base, "outside") : "../../outside", join(a.root, "external"));
  await expect(reconcileNode(request(a, ["a.txt", "z.txt"]))).rejects.toThrow(/root is empty/);
  expect(store.head("notes")).toEqual(head);
  expect(store.node("notes", a.id)).toEqual(node);
  await reconcileNode(request(b));
  expect(store.head("notes")).toEqual(head);
  expect(await read(b, "a.txt")).toBe("first");
  expect(await read(b, "z.txt")).toBe("last");
});

it.each(["equal", "ancestor"])("checks %s aliases across folder namespaces when an offline host reconnects, then allows separate roots", async (kind) => {
  const a = await machine(base, "a");
  const b = await machine(base, "b");
  const second = join(base, "second");
  const alias = join(base, "alias");
  const peer = join(base, "peer");
  await mkdir(second);
  await mkdir(peer);
  await put(a, "private.txt", "first namespace only");
  await mkdir(join(a.root, "child"));
  await writeFile(join(a.root, "child", "nested.txt"), "nested first namespace");
  await writeFile(join(second, "second.txt"), "second namespace only");
  await symlink(kind === "equal" ? a.root : join(a.root, "child"), alias);
  const folders = [folderOf([a, b]), folderOf([a, b], {
    id: "other", nodes: [{ hostId: a.id, path: alias }, { hostId: b.id, path: peer }],
  })];
  const store = openStore(join(base, "hub.db"));
  a.online = false;
  const transfers: string[] = [];
  a.before = b.before = (method) => { if (["read", "write", "link", "remove"].includes(method)) transfers.push(method); };
  const running = startCoordinator(store, [a, b], folders);
  try {
    await expect(running.coordinator.sync("notes", [a.id], 1000)).rejects.toThrow(/offline/);
    a.online = true;
    await vi.waitFor(() => expect(running.coordinator.status().folders[0]!.nodes[0]!.error).toMatch(/overlap/));
    for (const folder of folders) {
      await expect(running.coordinator.sync(folder.id, [a.id], 2000)).rejects.toThrow(/overlap/);
      expect(store.seq(folder.id)).toBe(0);
      expect(store.node(folder.id, a.id).acked).toBe(0);
    }
    expect(transfers).toEqual([]);
    expect(await read(b, "private.txt")).toBeNull();
    expect(await readFile(join(peer, "private.txt")).catch(() => null)).toBeNull();
    await unlink(alias);
    await symlink(second, alias);
    for (const folder of folders) await running.coordinator.sync(folder.id, undefined, 3000);
    expect(await read(b, "private.txt")).toBe("first namespace only");
    expect(await readFile(join(peer, "second.txt"), "utf8")).toBe("second namespace only");
    expect(await readFile(join(peer, "private.txt")).catch(() => null)).toBeNull();
    // A changed alias must be rechecked even on a download-only pass.
    await running.stop();
    await unlink(alias);
    await symlink(a.root, alias);
    const pass: PassRequest = {
      store, folder: folders[0]!, host: hostClient([a, b]), hostId: a.id, root: a.root,
      otherRoots: [alias], scope: null, signal: new AbortController().signal,
      now: Date.now, sliceMs: 10_000, transfers: new Map(), uploads: new Map(),
    };
    const seq = store.seq("notes");
    transfers.length = 0;
    await expect(reconcileNode(pass)).rejects.toThrow(/overlap/);
    expect(store.seq("notes")).toBe(seq);
    expect(transfers).toEqual([]);
  } finally { await running.stop(); }
});

it("refuses overlaps between two other configured roots even when the current root is separate", async () => {
  const current = await machine(base, "current");
  const other = join(base, "other");
  const alias = join(base, "alias");
  await mkdir(other);
  await symlink(other, alias);
  const outcome = await current.harness.experimental_call("scan", {
    root: current.root, otherRoots: [other, alias], ignorePaths: [],
  });
  expect(outcome).toEqual({ ok: false, reason: "overlapping-roots" });
});

it("rechecks root identity after awaiting cache persistence before accepting the snapshot", async () => {
  const { a, b, store, request } = await setup();
  const head = store.head("notes");
  const node = store.node("notes", a.id);
  const save = HashCache.prototype.save;
  let moved = false;
  vi.spyOn(HashCache.prototype, "save").mockImplementation(async function (this: HashCache, paths) {
    await save.call(this, paths);
    if (!moved) {
      moved = true;
      await rename(a.root, `${a.root}-moved`);
    }
  });
  await expect(reconcileNode(request(a))).rejects.toThrow(/root changed/);
  expect(moved).toBe(true);
  expect(store.head("notes")).toEqual(head);
  expect(store.node("notes", a.id)).toEqual(node);
  vi.restoreAllMocks();
  await reconcileNode(request(b));
  expect(await read(b, "z.txt")).toBe("last");
});
