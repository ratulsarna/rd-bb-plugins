import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { conflictPath } from "../lib/conflict-path";
import { cleanup, folderOf, machine, openStore, put, read, startCoordinator, tempDir } from "./helpers";

let base: string;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => { base = await tempDir(); });
afterEach(async () => { await stop?.(); stop = undefined; await cleanup(base); });

it.each(["file-to-directory", "directory-to-file"])("a single coordinator barrier completes a clean %s conversion", async (conversion) => {
  const a = await machine(base, "a");
  const b = await machine(base, "b");
  const store = openStore(join(base, "hub.db"));
  const original = conversion === "file-to-directory" ? "item" : "item/deep/child";
  const replacement = conversion === "file-to-directory" ? "item/deep/child" : "item";
  await put(a, original, "original");
  await put(a, "keep", "sentinel");
  const run = startCoordinator(store, [a, b], [folderOf([a, b])]);
  stop = run.stop;
  await run.coordinator.sync("notes");
  await rm(join(a.root, "item"), { recursive: true });
  b.before = async (method) => {
    if (method === "remove") await new Promise((resolve) => setTimeout(resolve, 30));
  };
  await put(a, replacement, "converted");
  await put(a, "unrelated", "latest live edit");
  const synced = await run.coordinator.sync("notes", undefined, 3000);
  expect(synced.nodes.every((node) => node.ready && node.error === null)).toBe(true);
  expect(synced.openConflicts).toBe(0);
  expect(await read(b, replacement)).toBe("converted");
  expect(await read(b, "unrelated")).toBe("latest live edit");
  expect(store.head("notes").get(original)!.content).toBeNull();
});

it("converges real long ASCII and Unicode conflicts with distinct truncated stems and extensions", async () => {
  const a = await machine(base, "a");
  const b = await machine(base, "b");
  expect(conflictPath("notes/a.md", "host1", new Date("2026-10-03T01:22:33Z"))).toBe("notes/a.sync-conflict-20261003-012233-host1.md");
  const names = [
    "a".repeat(250) + "1.txt", "a".repeat(250) + "2.txt",
    "界".repeat(80) + "1.txt", "界".repeat(80) + "2.txt",
    "stem." + "é".repeat(120) + "1", "stem." + "é".repeat(120) + "2",
  ];
  for (const [index, name] of names.entries()) await put(a, name, `base ${index}`);
  const store = openStore(join(base, "hub.db"));
  const folder = folderOf([a, b]);
  const run = startCoordinator(store, [a, b], [folder]);
  stop = run.stop;
  await run.coordinator.sync("notes");
  for (const [index, name] of names.entries()) {
    await put(a, name, `hub ${index}`);
    await put(b, name, `offline ${index}`);
  }
  const result = await run.coordinator.sync("notes", undefined, 5000);
  expect(result.nodes.every((node) => node.ready)).toBe(true);
  expect(result.openConflicts).toBe(names.length);
  expect(new Set(result.conflicts.map((conflict) => conflict.conflictPath)).size).toBe(names.length);
  for (const node of [a, b]) {
    const files = await readdir(node.root);
    expect(files.every((name) => Buffer.byteLength(name) <= 255)).toBe(true);
    const copies = files.filter((name) => name.includes(".sync-conflict-"));
    expect(copies).toHaveLength(names.length);
    const contents = await Promise.all(copies.map((name) => readFile(join(node.root, name), "utf8")));
    expect(contents.sort()).toEqual(names.map((_, index) => `offline ${index}`).sort());
    for (const [index, name] of names.entries()) expect(await read(node, name)).toBe(`hub ${index}`);
  }
  expect((await run.coordinator.sync("notes")).headVersion).toBe(result.headVersion);
});
