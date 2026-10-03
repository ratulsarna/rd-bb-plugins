import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { open, readFile, stat, utimes } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobWriter, HISTORY_RETENTION_MS } from "../lib/store";
import { reconcileNode, type PassRequest } from "../lib/reconcile";
import {
  cleanup,
  folderOf,
  hostClient,
  machine,
  openStore,
  put,
  tempDir,
} from "./helpers";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, stat: vi.fn(fs.stat) };
});
const fs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let base: string;
beforeEach(async () => {
  base = await tempDir();
});
afterEach(async () => {
  vi.mocked(stat).mockImplementation(fs.stat);
  await cleanup(base);
});
const content = (data: Buffer) => ({
  kind: "file" as const,
  hash: createHash("sha256").update(data).digest("hex"),
  size: data.length,
  exec: false,
});
const blobPath = (hash: string) => join(base, "blobs", hash.slice(0, 2), hash);

async function oldBlob(store: ReturnType<typeof openStore>, data: Buffer) {
  const c = content(data);
  const writer = await store.blobWriter();
  await writer.write(data);
  expect(await writer.finish(c.hash, c.size)).toBe(true);
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  await utimes(blobPath(c.hash), old, old);
  return c;
}

async function source(store: ReturnType<typeof openStore>, data: Buffer) {
  const node = await machine(base, "host-a");
  await put(node, "restored.bin", data);
  const request: PassRequest = {
    store,
    host: hostClient([node]),
    folder: folderOf([node]),
    hostId: node.id,
    root: node.root,
    scope: "all",
    signal: new AbortController().signal,
    now: Date.now,
    sliceMs: 10_000,
    uploads: new Map(),
    transfers: new Map(),
  };
  return { node, request };
}

describe("blob persistence and pruning", () => {
  it("rejects commits that would make a file or link another live entry's parent", async () => {
    const store = openStore(join(base, "hub.db"));
    const c = await oldBlob(store, Buffer.from("original bytes"));
    store.commit("children", "host-a", "item/child.txt", c, Date.now());
    const version = store.seq("children");
    expect(() =>
      store.commit("children", "host-b", "item", c, Date.now()),
    ).toThrow(/File and directory versions conflict/);
    expect(store.seq("children")).toBe(version);
    expect(store.head("children").has("item")).toBe(false);
    expect(await store.readBlob(c.hash, 0, c.size)).toEqual(
      Buffer.from("original bytes"),
    );
    store.commit(
      "parents",
      "host-a",
      "item",
      { kind: "symlink", target: "somewhere" },
      Date.now(),
    );
    expect(() =>
      store.commit("parents", "host-b", "item/child.txt", c, Date.now()),
    ).toThrow(/File and directory versions conflict/);
    expect(store.head("parents").has("item/child.txt")).toBe(false);
    expect(store.head("parents").get("item")?.content).toEqual({
      kind: "symlink",
      target: "somewhere",
    });
  });

  it("fully persists verified blobs when a single native write would be short", async () => {
    const store = openStore(join(base, "hub.db"));
    const data = randomBytes(128 * 1024 + 17);
    const c = content(data);
    const path = join(base, "short-write.tmp");
    const handle = await open(path, "wx", 0o600);
    const nativeWrite = handle.write.bind(handle);
    handle.write = ((buffer: Buffer) =>
      nativeWrite(
        buffer,
        0,
        Math.min(buffer.length, 7),
        null,
      )) as typeof handle.write;
    const writer = new BlobWriter(handle, path, blobPath);
    try {
      await writer.write(data);
      expect(await writer.finish(c.hash, c.size)).toBe(true);
      expect(await store.hasBlob(c.hash)).toBe(true);
      expect(content(await readFile(blobPath(c.hash)))).toEqual(c);
      expect(content(await store.readBlob(c.hash, 0, c.size))).toEqual(c);
    } finally {
      await writer.abort();
    }
  });

  it("protects reused old blobs from dedupe until commit, then prunes only unreferenced bytes", async () => {
    const store = openStore(join(base, "hub.db"));
    const data = randomBytes(8192);
    const reused = await oldBlob(store, data);
    const garbage = await oldBlob(store, randomBytes(4096));
    const { node, request } = await source(store, data);
    await put(node, "new.txt", "a different hash that must be read");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    node.before = async (method) => {
      if (method !== "read") return;
      expect(await store.hasBlob(reused.hash)).toBe(true);
      expect(store.head("notes").has("restored.bin")).toBe(false);
      started();
      await held;
    };
    const pass = reconcileNode(request);
    let pruning!: Promise<number>;
    let pruned = false;
    try {
      await entered;
      pruning = store.prune(Date.now()).then((count) => {
        pruned = true;
        return count;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pruned).toBe(false);
      expect(await readFile(blobPath(reused.hash))).toEqual(data);
    } finally {
      release();
      await pass;
      if (pruning) await pruning;
    }
    expect((await pass).acked).not.toBeNull();
    expect(store.head("notes").get("restored.bin")?.content).toEqual(reused);
    expect(await pruning).toBe(1);
    expect(await store.hasBlob(garbage.hash)).toBe(false);
    expect(await readFile(blobPath(reused.hash))).toEqual(data);
    store.commit(
      "notes",
      node.id,
      "restored.bin",
      null,
      Date.now() - HISTORY_RETENTION_MS - 1,
    );
    expect(await store.prune(Date.now())).toBe(1);
    expect(await store.hasBlob(reused.hash)).toBe(false);
  });

  it("waits for an in-progress prune before deciding whether restored bytes can be reused", async () => {
    const store = openStore(join(base, "hub.db"));
    const data = randomBytes(16384);
    const restored = await oldBlob(store, data);
    const { node, request } = await source(store, data);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(stat).mockImplementation((async (
      path: Parameters<typeof stat>[0],
    ) => {
      const info = await fs.stat(path);
      if (path === blobPath(restored.hash)) {
        started();
        await held;
      }
      return info;
    }) as typeof stat);
    const pruning = store.prune(Date.now());
    await entered;
    let scans = 0;
    let reads = 0;
    node.before = (method) => {
      if (method === "scan") scans += 1;
      if (method === "read") reads += 1;
    };
    const pass = reconcileNode(request);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(scans).toBe(0);
      expect(store.head("notes").has("restored.bin")).toBe(false);
    } finally {
      vi.mocked(stat).mockImplementation(fs.stat);
      release();
      await pruning;
      await pass;
    }
    expect(await pruning).toBe(1);
    expect((await pass).acked).not.toBeNull();
    expect(reads).toBe(1);
    expect(await readFile(join(node.root, "restored.bin"))).toEqual(data);
    expect(await readFile(blobPath(restored.hash))).toEqual(data);
    expect(store.head("notes").get("restored.bin")?.content).toEqual(restored);
    expect(await store.prune(Date.now())).toBe(0);
  });
});
