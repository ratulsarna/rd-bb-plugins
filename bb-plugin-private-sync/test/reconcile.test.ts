import { randomBytes, createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHUNK_BYTES } from "../contract";
import { reconcileNode, type PassRequest } from "../lib/reconcile";
import { type Store } from "../lib/store";
import {
  cleanup,
  folderOf,
  hostClient,
  machine,
  openStore,
  put,
  read,
  tempDir,
  type Machine,
} from "./helpers";

let base: string;
beforeEach(async () => {
  base = await tempDir();
});
afterEach(async () => {
  await cleanup(base);
});

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function request(
  store: Store,
  machines: Machine[],
  node: Machine,
  scope: PassRequest["scope"] = "all",
): PassRequest {
  return {
    store,
    host: hostClient(machines),
    folder: folderOf(machines),
    hostId: node.id,
    root: node.root,
    scope,
    signal: new AbortController().signal,
    now: Date.now,
    sliceMs: 10_000,
    transfers: new Map(),
    uploads: new Map(),
  };
}
async function pair() {
  const machines = [
    await machine(base, "host-a"),
    await machine(base, "host-b"),
  ];
  const [a, b] = machines as [Machine, Machine];
  const store = openStore(join(base, "hub.db"));
  await put(a, "keep.txt", "keep");
  await reconcileNode(request(store, machines, a));
  await reconcileNode(request(store, machines, b));
  return { machines, a, b, store };
}

describe("reconciliation safety", () => {
  it("recovers after restart when the last held path was removed but its reply was lost", async () => {
    const machines = [
      await machine(base, "host-a"),
      await machine(base, "host-b"),
    ];
    const [a, b] = machines as [Machine, Machine];
    const dbPath = join(base, "hub.db");
    let store = openStore(dbPath);
    await put(a, "old.txt", "the only held file");
    await reconcileNode(request(store, machines, a));
    await reconcileNode(request(store, machines, b));
    const big = randomBytes(CHUNK_BYTES * 2 + 321);
    await put(a, "new.bin", big);
    await unlink(join(a.root, "old.txt"));
    await reconcileNode(request(store, machines, a));
    let removed = false;
    b.before = async (method, input) => {
      if (method === "write")
        await new Promise((resolve) => setTimeout(resolve, 40));
      if (method === "remove" && !removed) {
        removed = true;
        await b.harness.experimental_call("remove", input);
        throw new Error("Lost remove reply");
      }
    };
    const first = request(store, machines, b, null);
    first.sliceMs = 15;
    await expect(reconcileNode(first)).rejects.toThrow(/Lost remove reply/);
    expect(removed).toBe(true);
    expect(await read(b, "old.txt")).toBeNull();
    expect(await read(b, "new.bin")).toBeNull();
    expect(store.bases("notes", b.id).has("old.txt")).toBe(true);
    store = openStore(dbPath);
    b.before = undefined;
    const resumed = request(store, machines, b);
    const seq = store.seq("notes");
    expect((await reconcileNode(resumed)).acked).toBe(seq);
    expect(sha(await readFile(join(b.root, "new.bin")))).toBe(sha(big));
    expect(store.bases("notes", b.id).has("old.txt")).toBe(false);
    expect(store.head("notes").get("old.txt")?.content).toBeNull();
    expect(store.seq("notes")).toBe(seq);
    expect(sha(await readFile(join(a.root, "new.bin")))).toBe(sha(big));
  });

  it.each(["file", "directory"] as const)(
    "fails closed on offline divergence when the hub has the %s version",
    async (first) => {
      const { machines, a, b, store } = await pair();
      const hubPath = first === "file" ? "item" : "item/child.txt";
      const localPath = first === "file" ? "item/child.txt" : "item";
      await put(a, hubPath, "hub original version");
      await put(b, localPath, "offline local version");
      await unlink(join(b.root, "keep.txt"));
      await reconcileNode(request(store, machines, a));
      const seq = store.seq("notes");
      await expect(reconcileNode(request(store, machines, b))).rejects.toThrow(
        /File and directory versions conflict/,
      );
      expect(store.seq("notes")).toBe(seq);
      expect(store.head("notes").has(localPath)).toBe(false);
      expect(store.head("notes").get(hubPath)?.content?.kind).toBe("file");
      expect(await read(a, hubPath)).toBe("hub original version");
      expect(await read(b, localPath)).toBe("offline local version");
      expect(store.node("notes", b.id).acked).toBeLessThan(seq);
      await expect(
        reconcileNode(request(store, machines, b, null)),
      ).resolves.toMatchObject({ acked: null, blocked: 1 });
      expect(await read(b, localPath)).toBe("offline local version");
    },
  );

  it("permits a clean file-to-directory conversion while retaining a valid head", async () => {
    const { machines, a, b, store } = await pair();
    await put(a, "item", "original file");
    await reconcileNode(request(store, machines, a));
    await reconcileNode(request(store, machines, b));
    await unlink(join(a.root, "item"));
    await put(a, "item/child.txt", "replacement child");
    await reconcileNode(request(store, machines, a));
    const target = request(store, machines, b);
    await reconcileNode(target);
    expect((await reconcileNode(target)).acked).toBe(store.seq("notes"));
    expect(store.head("notes").get("item")?.content).toBeNull();
    expect(await read(b, "item/child.txt")).toBe("replacement child");
  });

  it("retries every empty-hash dependency when its representative becomes nonempty before read", async () => {
    const { machines, a, b, store } = await pair();
    for (const path of ["one.txt", "two.txt"]) await put(a, path, "");
    let changed: string | null = null;
    a.before = async (method, input) => {
      if (method !== "read" || changed) return;
      const range = input.ranges.find((range: any) => range.size === 0);
      if (!range) return;
      changed = range.path;
      await put(a, changed!, "no longer empty");
    };
    const pass = request(store, machines, a);
    const first = await reconcileNode(pass);
    expect(changed).not.toBeNull();
    expect(first.retry.sort()).toEqual(["one.txt", "two.txt"]);
    expect(first.acked).toBeNull();
    for (const path of ["one.txt", "two.txt"]) {
      expect(store.head("notes").has(path)).toBe(false);
      expect(store.bases("notes", a.id).has(path)).toBe(false);
    }
    expect(await store.hasBlob(sha(Buffer.alloc(0)))).toBe(false);
    expect((await reconcileNode(pass)).acked).not.toBeNull();
    await reconcileNode(request(store, machines, b));
    expect(await read(b, changed!)).toBe("no longer empty");
    expect(await read(b, changed === "one.txt" ? "two.txt" : "one.txt")).toBe(
      "",
    );
  });
});
