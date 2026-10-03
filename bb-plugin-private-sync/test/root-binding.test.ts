import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { reconcileNode, type PassRequest } from "../lib/reconcile";
import { MIGRATIONS } from "../lib/store";
import { CHUNK_BYTES } from "../contract";
import { cleanup, folderOf, hostClient, machine, openStore, put, read, startCoordinator, tempDir, type Machine } from "./helpers";

let base: string;
beforeEach(async () => { base = await tempDir(); });
afterEach(async () => { await cleanup(base); });

async function setup() {
  const a = await machine(base, "a");
  const b = await machine(base, "b");
  const machines = [a, b];
  const store = openStore(join(base, "hub.db"));
  const folder = folderOf(machines);
  const request = (node: Machine, scope: PassRequest["scope"] = "all"): PassRequest => ({
    store, host: hostClient(machines), folder, hostId: node.id, root: node.root,
    scope, signal: new AbortController().signal, now: Date.now, sliceMs: 10_000,
    transfers: new Map(), uploads: new Map(),
  });
  await put(a, "item", "expected");
  await put(a, "keep", "sentinel");
  await reconcileNode(request(a));
  await reconcileNode(request(b));
  store.markSeeded(folder.id);
  return { a, b, machines, store, folder, request };
}

it.each(["remove", "write", "link"] as const)("binds a coordinator %s to the scan across root swap, restart, and explicit mapping adoption", async (method) => {
  const { a, b, machines, store, folder, request } = await setup();
  if (method === "remove") await unlink(join(a.root, "item"));
  else if (method === "write") await put(a, "item", "hub edit");
  else { await unlink(join(a.root, "item")); await symlink("keep", join(a.root, "item")); }
  await reconcileNode(request(a));
  const head = store.head(folder.id);
  const ack = store.node(folder.id, b.id);
  const replacement = join(base, "replacement");
  await mkdir(replacement);
  await writeFile(join(replacement, "item"), "expected");
  await writeFile(join(replacement, "keep"), "sentinel");
  let swapped = false;
  b.before = async (op) => {
    if (op !== method || swapped) return;
    swapped = true;
    await rename(b.root, `${b.root}-moved`);
    await symlink(replacement, b.root);
  };
  let run = startCoordinator(store, machines, [folder]);
  try {
    await expect(run.coordinator.sync(folder.id, [b.id], 2000)).rejects.toThrow(/root/);
    expect(swapped).toBe(true);
    expect(await readFile(join(`${b.root}-moved`, "item"), "utf8")).toBe("expected");
    expect(await readFile(join(replacement, "item"), "utf8")).toBe("expected");
    expect(store.node(folder.id, b.id)).toEqual(ack);
    expect(store.head(folder.id)).toEqual(head);
    await run.stop();
    b.before = undefined;
    const reopened = openStore(join(base, "hub.db"));
    run = startCoordinator(reopened, machines, [folder]);
    await expect(run.coordinator.sync(folder.id, [b.id], 2000)).rejects.toThrow(/root/);
    expect(await readdir(replacement)).toEqual(["item", "keep"]);
    expect(reopened.node(folder.id, b.id)).toEqual(ack);
    await run.stop();
    // A different configured path is an explicit fresh-node adoption, with no stale base.
    const adopted = { ...folder, nodes: folder.nodes.map((node) => node.hostId === b.id ? { ...node, path: replacement } : node) };
    run = startCoordinator(reopened, machines, [adopted]);
    const status = await run.coordinator.sync(folder.id, undefined, 3000);
    expect(status.nodes.every((node) => node.ready)).toBe(true);
    const files = await readdir(replacement);
    const bytes = await Promise.all(files.map((path) => readFile(join(replacement, path), "utf8").catch(() => "")));
    expect(bytes).toContain("expected");
    expect(await readFile(join(`${b.root}-moved`, "item"), "utf8")).toBe("expected");
  } finally { await run.stop(); }
});

it.each(["read", "write"] as const)("refuses queued %s chunks with an old scan identity and restarts safely on the restored directory", async (method) => {
  const { a, b, store, folder, request } = await setup();
  const bytes = Buffer.alloc(CHUNK_BYTES + 37, 71);
  await put(a, "large", bytes);
  if (method === "write") await reconcileNode(request(a));
  const node = method === "read" ? a : b;
  const replacement = join(base, "replacement");
  await mkdir(replacement);
  await writeFile(join(replacement, "item"), "expected");
  let chunks = 0;
  node.before = async (op) => {
    if (op !== method || ++chunks !== 2) return;
    await rename(node.root, `${node.root}-moved`);
    await symlink(replacement, node.root);
  };
  const pass = request(node);
  const ack = store.node(folder.id, node.id);
  await expect(reconcileNode(pass)).rejects.toThrow(/root identity changed/);
  expect(chunks).toBe(2);
  expect(await readdir(replacement)).toEqual(["item"]);
  expect(store.node(folder.id, node.id)).toEqual(ack);
  await expect(reconcileNode(pass)).rejects.toThrow(/root changed/);
  await unlink(node.root);
  await rename(`${node.root}-moved`, node.root);
  node.before = undefined;
  expect((await reconcileNode(pass)).acked).not.toBeNull();
  await reconcileNode(request(b));
  expect(await readFile(join(b.root, "large"))).toEqual(bytes);
  expect(await readFile(join(replacement, "item"), "utf8")).toBe("expected");
});

it.each(["present-stale", "absent"] as const)("migrates old-schema %s bases without resurrecting tombstones or deleting hub copies", async (kind) => {
  const { a, b, store, folder, request } = await setup();
  if (kind === "present-stale") {
    await unlink(join(a.root, "item"));
    await reconcileNode(request(a));
  } else await unlink(join(b.root, "item"));
  const head = store.head(folder.id);
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(join(base, "hub.db"));
  db.exec("ALTER TABLE nodes DROP COLUMN root_identity");
  db.pragma(`user_version = ${MIGRATIONS.length - 1}`);
  db.close();
  const upgraded = openStore(join(base, "hub.db"));
  expect(upgraded.rootIdentity(folder.id, b.id)).toBeNull();
  expect(upgraded.bases(folder.id, b.id).has("item")).toBe(true);
  expect((await reconcileNode({ ...request(b, null), store: upgraded })).acked).not.toBeNull();
  expect(await read(b, "item")).toBe(kind === "present-stale" ? null : "expected");
  expect(upgraded.head(folder.id)).toEqual(head);
  expect(upgraded.rootIdentity(folder.id, b.id)).not.toBeNull();
});
