import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHUNK_BYTES } from "../contract";
import {
  cleanup,
  conflictCopies,
  exists,
  folderOf,
  linkTarget,
  machine,
  openStore,
  put,
  read,
  startCoordinator,
  tempDir,
  type Machine,
} from "./helpers";

let base: string;
let stops: (() => Promise<void>)[] = [];

beforeEach(async () => {
  base = await tempDir();
  stops = [];
});
afterEach(async () => {
  for (const stop of stops) await stop();
  await cleanup(base);
});

async function setup(
  count: number,
  seed?: (machines: Machine[]) => Promise<void>,
) {
  const machines: Machine[] = [];
  for (let index = 0; index < count; index += 1)
    machines.push(await machine(base, `host-${"abc"[index]}`));
  await seed?.(machines);
  const store = openStore(join(base, "hub.db"));
  const run = startCoordinator(store, machines, [folderOf(machines)]);
  stops.push(run.stop);
  return { machines, store, ...run };
}

async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${label}`);
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("two-way sync", () => {
  it("onboards divergent machines and preserves the non-primary side as a conflict copy", async () => {
    const { machines, coordinator } = await setup(2, async ([a, b]) => {
      await put(a!, "notes/plan.md", "from A");
      await put(a!, "only-a.txt", "a");
      await put(b!, "notes/plan.md", "from B");
      await put(b!, "only-b.txt", "b");
    });
    const status = await coordinator.sync("notes");
    for (const m of machines) {
      expect(await read(m, "notes/plan.md")).toBe("from A");
      expect(await read(m, "only-a.txt")).toBe("a");
      expect(await read(m, "only-b.txt")).toBe("b");
      const copies = conflictCopies(
        await readdir(join(m.root, "notes")),
        "plan",
      );
      expect(copies).toHaveLength(1);
      expect(await read(m, `notes/${copies[0]}`)).toBe("from B");
    }
    expect(status.openConflicts).toBe(1);
    expect(status.conflicts[0]).toMatchObject({
      path: "notes/plan.md",
      hostId: "host-b",
      kind: "edit-edit",
    });
    expect(status.nodes.map((node) => node.ready)).toEqual([true, true]);
  });

  it("resolves offline edits and deletes without silent overwrite or resurrection", async () => {
    const { machines, coordinator } = await setup(2, async ([a]) => {
      for (const name of [
        "both-edit",
        "delete-vs-edit",
        "stale",
        "edit-vs-delete",
        "both-delete",
      ])
        await put(a!, `${name}.md`, "v1");
    });
    const [a, b] = machines as [Machine, Machine];
    await coordinator.sync("notes");
    b.online = false;
    await until(
      () => coordinator.status().folders[0]!.nodes[1]!.phase === "offline",
      "b offline",
    );

    await put(a, "both-edit.md", "A2");
    await unlink(join(a.root, "delete-vs-edit.md"));
    await unlink(join(a.root, "stale.md"));
    await put(a, "edit-vs-delete.md", "A2");
    await unlink(join(a.root, "both-delete.md"));
    await coordinator.sync("notes", [a.id]);

    await put(b, "both-edit.md", "B2");
    await put(b, "delete-vs-edit.md", "B edit");
    await unlink(join(b.root, "edit-vs-delete.md"));
    await unlink(join(b.root, "both-delete.md"));
    b.online = true;
    await until(
      () => coordinator.status().folders[0]!.nodes[1]!.phase !== "offline",
      "b online",
    );
    const status = await coordinator.sync("notes");

    for (const m of machines) {
      const names = await readdir(m.root);
      expect(await read(m, "both-edit.md")).toBe("A2");
      expect(await read(m, `${conflictCopies(names, "both-edit")[0]}`)).toBe(
        "B2",
      );
      // A's delete stands; B's edit of the deleted file survives as a copy.
      expect(names).not.toContain("delete-vs-edit.md");
      expect(
        await read(m, `${conflictCopies(names, "delete-vs-edit")[0]}`),
      ).toBe("B edit");
      // B never touched stale.md, so A's tombstone wins and nothing comes back.
      expect(names).not.toContain("stale.md");
      // B deleted a file A edited: the edit is restored.
      expect(await read(m, "edit-vs-delete.md")).toBe("A2");
      expect(conflictCopies(names, "both-delete")).toEqual([]);
    }
    expect(status.conflicts.map((conflict) => conflict.kind).sort()).toEqual([
      "delete-edit",
      "edit-delete",
      "edit-edit",
    ]);
  });

  it("carries changes made while the server was down after a restart, without re-uploading", async () => {
    const machines = [
      await machine(base, "host-a"),
      await machine(base, "host-b"),
    ];
    const [a, b] = machines as [Machine, Machine];
    await put(a, "keep.md", "keep");
    await put(a, "gone.md", "gone");
    await put(a, "change.md", "v1");
    const dbPath = join(base, "hub.db");
    const first = startCoordinator(openStore(dbPath), machines, [
      folderOf(machines),
    ]);
    await first.coordinator.sync("notes");
    await first.stop();

    // A restart must secure existing hub metadata created under a permissive umask.
    await chmod(base, 0o775);
    await chmod(dbPath, 0o644);

    await unlink(join(a.root, "gone.md"));
    await put(b, "change.md", "v2 from b");
    const reads: string[] = [];
    for (const m of machines)
      m.before = (method, input) =>
        void (
          method === "read" &&
          reads.push(...input.ranges.map((range: any) => range.path))
        );

    const second = startCoordinator(openStore(dbPath), machines, [
      folderOf(machines),
    ]);
    stops.push(second.stop);
    const status = await second.coordinator.sync("notes");
    expect((await stat(base)).mode & 0o777).toBe(0o700);
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
    for (const m of machines) {
      expect(await read(m, "keep.md")).toBe("keep");
      expect(await read(m, "change.md")).toBe("v2 from b");
      expect(await exists(join(m.root, "gone.md"))).toBe(false);
    }
    expect(reads).toEqual(["change.md"]);
    expect(status.openConflicts).toBe(0);
  });

  it("refuses to overwrite a file the user changes while a remote write is landing", async () => {
    const { machines, coordinator } = await setup(2, async ([a]) =>
      put(a!, "doc.md", "v1"),
    );
    const [a, b] = machines as [Machine, Machine];
    await coordinator.sync("notes");
    let raced = false;
    b.before = async (method, input) => {
      const landing =
        method === "write" &&
        input.items.some((item: any) => item.path === "doc.md" && item.commit);
      if (landing && !raced) {
        raced = true;
        await put(b, "doc.md", "typed on B meanwhile");
      }
    };
    await put(a, "doc.md", "from A");
    const status = await coordinator.sync("notes");
    expect(raced).toBe(true);
    for (const m of machines) {
      const names = await readdir(m.root);
      expect(await read(m, "doc.md")).toBe("from A");
      expect(await read(m, conflictCopies(names, "doc")[0]!)).toBe(
        "typed on B meanwhile",
      );
      expect(names.some((name) => name.startsWith(".bb-private-sync-"))).toBe(
        false,
      );
    }
    expect(status.openConflicts).toBe(1);
  });

  it("moves large binaries in verified chunks with modes and safe symlinks, and drops echoes", async () => {
    const big = randomBytes(CHUNK_BYTES * 2 + 12345);
    const { machines, coordinator } = await setup(2, async ([a]) => {
      await put(a!, "data/model.bin", big);
      await put(a!, "data/empty.bin", Buffer.alloc(0));
      await put(a!, "run.sh", "#!/bin/sh\necho hi\n");
      await chmod(join(a!.root, "run.sh"), 0o755);
      await put(a!, "AGENTS.md", "agents");
      await symlink("AGENTS.md", join(a!.root, "CLAUDE.md"));
      // Many links in one directory land in parallel; their temporary names must not collide.
      await mkdir(join(a!.root, "links"));
      for (let index = 0; index < 20; index += 1)
        await symlink("../AGENTS.md", join(a!.root, `links/${index}.md`));
      await symlink("../../outside", join(a!.root, "escape"));
      await symlink("/etc/hostname", join(a!.root, "absolute"));
      await put(a!, ".git/HEAD", "ref");
      await put(a!, "web/node_modules/x/index.js", "x");
      await put(a!, "scratch/output.txt", "useful scratch");
      for (const local of [
        ".env",
        "app/.env.local",
        ".mcp.json",
        ".claude/projects/p.jsonl",
        ".claude/settings.local.json",
      ])
        await put(a!, local, "machine-local");
      await put(a!, ".claude/skills/s/SKILL.md", "portable skill");
    });
    const [, b] = machines as [Machine, Machine];
    await coordinator.sync("notes");

    expect(sha(await readFile(join(b.root, "data/model.bin")))).toBe(sha(big));
    expect((await stat(join(b.root, "data/empty.bin"))).size).toBe(0);
    const mode = async (path: string) =>
      (await stat(join(b.root, path))).mode & 0o777;
    expect(await mode("run.sh")).toBe(0o700);
    expect(await mode("AGENTS.md")).toBe(0o600);
    expect(await linkTarget(b, "CLAUDE.md")).toBe("AGENTS.md");
    for (let index = 0; index < 20; index += 1)
      expect(await linkTarget(b, `links/${index}.md`)).toBe("../AGENTS.md");
    expect(await linkTarget(b, "escape")).toBeNull();
    expect(await linkTarget(b, "absolute")).toBeNull();
    expect(await exists(join(b.root, ".git"))).toBe(false);
    expect(await exists(join(b.root, "web/node_modules"))).toBe(false);
    expect(await read(b, "scratch/output.txt")).toBe("useful scratch");
    expect(await read(b, ".claude/skills/s/SKILL.md")).toBe("portable skill");
    for (const local of [
      ".env",
      "app",
      ".mcp.json",
      ".claude/projects",
      ".claude/settings.local.json",
    ])
      expect(await exists(join(b.root, local))).toBe(false);

    // A remote edit replacing a file B had opened up to others still lands owner-only.
    await chmod(join(b.root, "AGENTS.md"), 0o644);
    await coordinator.sync("notes", [b.id]);
    await put(machines[0]!, "AGENTS.md", "agents v2");
    const edited = await coordinator.sync("notes");
    expect(await read(b, "AGENTS.md")).toBe("agents v2");
    expect(await mode("AGENTS.md")).toBe(0o600);

    // The watcher on B reports the files the hub just wrote; they must not bounce back as new versions.
    coordinator.onSignal(b.id, "notes", [
      "data",
      "run.sh",
      "CLAUDE.md",
      "AGENTS.md",
    ]);
    const after = await coordinator.sync("notes");
    expect(after.headVersion).toBe(edited.headVersion);
  });

  it("blocks writes through a symlinked directory instead of escaping the root", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    const { machines, coordinator } = await setup(2, async ([a, b]) => {
      await put(a!, "docs/file.md", "from A");
      await put(a!, "other.md", "fine");
      await symlink(outside, join(b!.root, "docs"));
    });
    const [, b] = machines as [Machine, Machine];
    await expect(coordinator.sync("notes")).rejects.toThrow(
      /cannot be written/,
    );
    expect(await readdir(outside)).toEqual([]);
    expect(await read(b, "other.md")).toBe("fine");

    await expect(
      b.harness.experimental_call("write", {
        root: b.root,
        items: [
          {
            path: "../x",
            tempId: "abcdefgh",
            offset: 0,
            data: "",
            commit: null,
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      b.harness.experimental_call("link", {
        root: b.root,
        path: "l",
        target: "../../etc/passwd",
        expected: null,
      }),
    ).rejects.toThrow(/leaves the root/);
  });

  it("retries a source file that changes while it is being read", async () => {
    const original = randomBytes(CHUNK_BYTES + 100);
    const { machines, coordinator } = await setup(2);
    const [a, b] = machines as [Machine, Machine];
    await coordinator.sync("notes");
    await writeFile(join(a.root, "log.bin"), original);
    let grew = false;
    a.before = async (method, input) => {
      if (method === "read" && input.ranges[0].offset > 0 && !grew) {
        grew = true;
        await appendFile(join(a.root, "log.bin"), "tail");
      }
    };
    await coordinator.sync("notes");
    expect(grew).toBe(true);
    expect(sha(await readFile(join(b.root, "log.bin")))).toBe(
      sha(Buffer.concat([original, Buffer.from("tail")])),
    );
  });

  it("lets a live edit reach other machines while a new machine is still downloading", async () => {
    // c comes before b in the config, so picking nodes in config order would let c's long download starve b.
    const a = await machine(base, "host-a");
    const c = await machine(base, "host-c");
    const b = await machine(base, "host-b");
    for (let index = 0; index < 24; index += 1)
      await put(a, `seed/${index}.bin`, randomBytes(900_000));
    const machines = [a, c, b];
    const store = openStore(join(base, "hub.db"));
    const run = startCoordinator(store, machines, [folderOf(machines)], {
      sliceMs: 1,
    });
    stops.push(run.stop);
    c.online = false;
    await run.coordinator.sync("notes", [a.id, b.id]);

    let cWrites = 0;
    let cWritesWhenBGotEdit = -1;
    let cWriteWithEdit = -1;
    c.before = async (method, input) => {
      if (method !== "write") return;
      cWrites += 1;
      if (input.items.some((item: any) => item.path === "z-live.md"))
        cWriteWithEdit = cWrites;
      if (cWrites === 1) {
        await put(a, "z-live.md", "typed now");
        run.coordinator.onSignal(a.id, "notes", ["z-live.md"]);
      }
    };
    b.before = (method, input) => {
      if (
        method === "write" &&
        input.items.some((item: any) => item.path === "z-live.md")
      )
        cWritesWhenBGotEdit = cWrites;
    };
    c.online = true;
    await until(
      () => run.coordinator.status().folders[0]!.nodes[1]!.phase !== "offline",
      "c online",
    );
    await run.coordinator.sync("notes");
    expect(await read(b, "z-live.md")).toBe("typed now");
    expect(await read(c, "z-live.md")).toBe("typed now");
    expect(cWritesWhenBGotEdit).toBeGreaterThan(0);
    expect(cWritesWhenBGotEdit).toBeLessThan(cWrites);
    // On c itself the edit jumps ahead of the remaining bulk download.
    expect(cWriteWithEdit).toBeLessThan(cWrites);
  });

  it("publishes a ready peer's live edit between slow chunks of a bootstrap binary", async () => {
    const a = await machine(base, "host-a");
    const c = await machine(base, "host-c");
    const b = await machine(base, "host-b");
    const d = await machine(base, "host-d");
    const machines = [a, c, b, d];
    const big = randomBytes(CHUNK_BYTES * 8 + 321);
    await put(a, "binary.dat", big);
    c.online = false;
    const run = startCoordinator(
      openStore(join(base, "hub.db")),
      machines,
      [folderOf(machines)],
      { sliceMs: 15 },
    );
    stops.push(run.stop);
    await run.coordinator.sync("notes", [a.id, b.id, d.id]);

    const chunks: { offset: number; tempId: string }[] = [];
    let injected = false;
    let committing = false;
    let liveBeforeCommit = false;
    c.before = async (method, input) => {
      if (method !== "write") return;
      if (input.items.some((item: any) => item.path === "live.txt"))
        liveBeforeCommit = !committing;
      const chunk = input.items.find((item: any) => item.path === "binary.dat");
      if (!chunk) return;
      chunks.push({ offset: chunk.offset, tempId: chunk.tempId });
      committing ||= chunk.commit !== null;
      if (!injected) {
        await put(b, "live.txt", "typed during bootstrap");
        run.coordinator.onSignal(b.id, "notes", ["live.txt"]);
        injected = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
    c.online = true;
    await until(() => injected, "bootstrap starts");
    let allSettled = false;
    const all = run.coordinator.sync("notes").then((status) => {
      allSettled = true;
      return status;
    });
    const ready = await run.coordinator.sync("notes", [a.id, b.id, d.id]);
    for (const m of [a, b, d]) {
      expect(await read(m, "live.txt")).toBe("typed during bootstrap");
      expect(ready.nodes.find((node) => node.hostId === m.id)?.ready).toBe(
        true,
      );
    }
    expect(committing).toBe(false);
    expect(await exists(join(c.root, "binary.dat"))).toBe(false);
    expect(allSettled).toBe(false);
    expect(ready.nodes.find((node) => node.hostId === c.id)?.ready).toBe(false);

    const final = await all;
    expect(liveBeforeCommit).toBe(true);
    expect(await read(c, "live.txt")).toBe("typed during bootstrap");
    expect(sha(await readFile(join(c.root, "binary.dat")))).toBe(sha(big));
    expect(chunks.map((chunk) => chunk.offset)).toEqual(
      Array.from({ length: 9 }, (_, index) => index * CHUNK_BYTES),
    );
    expect(new Set(chunks.map((chunk) => chunk.tempId)).size).toBe(1);
    expect(final.nodes.every((node) => node.ready)).toBe(true);
    expect(final.openConflicts).toBe(0);
  });

  it("applies a live delete ahead of four unfinished large downloads", async () => {
    const machines = [
      await machine(base, "host-a"),
      await machine(base, "host-b"),
      await machine(base, "host-c"),
    ];
    const [a, b, c] = machines as [Machine, Machine, Machine];
    await put(a, "keep.txt", "keep");
    await put(a, "delete.txt", "delete during bootstrap");
    const store = openStore(join(base, "hub.db"));
    const run = startCoordinator(store, machines, [folderOf(machines)], {
      sliceMs: 15,
    });
    stops.push(run.stop);
    await run.coordinator.sync("notes");
    c.online = false;
    await until(
      () => run.coordinator.status().folders[0]!.nodes[2]!.phase === "offline",
      "c offline",
    );
    const binaries = Array.from({ length: 4 }, () =>
      randomBytes(CHUNK_BYTES * 3 + 321),
    );
    for (const [index, data] of binaries.entries())
      await put(a, `${index}.bin`, data);
    await run.coordinator.sync("notes", [a.id, b.id]);
    let injected = false;
    let commits = 0;
    let commitsAtDelete = -1;
    c.before = async (method, input) => {
      if (method === "remove" && input.path === "delete.txt")
        commitsAtDelete = commits;
      if (method !== "write") return;
      const chunk = input.items.find((item: any) => item.path.endsWith(".bin"));
      if (!chunk) return;
      if (chunk.commit) commits += 1;
      if (!injected) {
        injected = true;
        await unlink(join(a.root, "delete.txt"));
        run.coordinator.onSignal(a.id, "notes", ["delete.txt"]);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
    c.online = true;
    await until(() => injected, "c starts large downloads");
    const final = await run.coordinator.sync("notes");
    expect(commitsAtDelete).toBe(0);
    for (const m of machines)
      expect(await exists(join(m.root, "delete.txt"))).toBe(false);
    for (const [index, data] of binaries.entries())
      expect(sha(await readFile(join(c.root, `${index}.bin`)))).toBe(sha(data));
    expect(final.nodes.every((node) => node.ready)).toBe(true);
    expect(final.openConflicts).toBe(0);
  });

  it("publishes completed small files and a live peer edit between slow upload chunks", async () => {
    const machines = [
      await machine(base, "host-a"),
      await machine(base, "host-b"),
      await machine(base, "host-c"),
    ];
    const [a, b, c] = machines as [Machine, Machine, Machine];
    const store = openStore(join(base, "hub.db"));
    const run = startCoordinator(store, machines, [folderOf(machines)], {
      sliceMs: 15,
    });
    stops.push(run.stop);
    await run.coordinator.sync("notes");
    const big = randomBytes(CHUNK_BYTES * 8 + 321);
    await put(b, "binary.dat", big);
    await put(b, "small.txt", "completed alongside the upload");
    const offsets: number[] = [];
    let injected = false;
    let finishing = false;
    let liveBeforeFinish = false;
    b.before = async (method, input) => {
      if (
        method === "write" &&
        input.items.some((item: any) => item.path === "live.txt")
      )
        liveBeforeFinish = !finishing;
      if (method !== "read") return;
      const range = input.ranges.find(
        (range: any) => range.path === "binary.dat",
      );
      if (!range) return;
      offsets.push(range.offset);
      finishing ||= range.offset + range.length >= range.size;
      if (!injected) {
        await put(a, "live.txt", "typed while B uploads");
        run.coordinator.onSignal(a.id, "notes", ["live.txt"]);
        injected = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
    let allSettled = false;
    const all = run.coordinator.sync("notes").then((status) => {
      allSettled = true;
      return status;
    });
    await until(() => injected, "large upload starts");
    const ready = await run.coordinator.sync("notes", [a.id, c.id]);
    expect(store.head("notes").get("small.txt")?.content?.kind).toBe("file");
    expect(store.head("notes").has("binary.dat")).toBe(false);
    expect(await store.hasBlob(sha(big))).toBe(false);
    expect(finishing).toBe(false);
    expect(allSettled).toBe(false);
    expect(ready.nodes.find((node) => node.hostId === b.id)?.ready).toBe(false);
    for (const m of [a, c]) {
      expect(await read(m, "small.txt")).toBe("completed alongside the upload");
      expect(await read(m, "live.txt")).toBe("typed while B uploads");
      expect(ready.nodes.find((node) => node.hostId === m.id)?.ready).toBe(
        true,
      );
    }
    const final = await all;
    expect(liveBeforeFinish).toBe(true);
    for (const m of machines) {
      expect(sha(await readFile(join(m.root, "binary.dat")))).toBe(sha(big));
      expect(await read(m, "live.txt")).toBe("typed while B uploads");
    }
    expect(offsets).toEqual(
      Array.from({ length: 9 }, (_, index) => index * CHUNK_BYTES),
    );
    expect(final.nodes.every((node) => node.ready)).toBe(true);
    expect(final.openConflicts).toBe(0);
    expect(await readdir(join(base, "blobs", "tmp"))).toEqual([]);
  });

  it.each(["mid-read", "between-slices"] as const)(
    "retries all shared-hash upload dependencies when the representative changes %s",
    async (transition) => {
      const a = await machine(base, "host-a");
      const b = await machine(base, "host-b");
      const machines = [a, b];
      await put(a, "keep.txt", "keep");
      const store = openStore(join(base, "hub.db"));
      const run = startCoordinator(store, machines, [folderOf(machines)], {
        sliceMs: 1,
      });
      stops.push(run.stop);
      await run.coordinator.sync("notes");
      const original = randomBytes(CHUNK_BYTES * 2 + 321);
      const replacement = Buffer.concat([original, Buffer.from("tail")]);
      for (const path of ["one.bin", "two.bin"]) await put(a, path, original);
      let representative: string | null = null;
      let changed = false;
      const reads: { path: string; offset: number }[] = [];
      const change = async () => {
        expect(store.head("notes").has("one.bin")).toBe(false);
        expect(store.head("notes").has("two.bin")).toBe(false);
        expect(await store.hasBlob(sha(original))).toBe(false);
        await appendFile(join(a.root, representative!), "tail");
        run.coordinator.onSignal(a.id, "notes", [representative!]);
        changed = true;
      };
      a.before = async (method, input) => {
        if (method !== "read") return;
        const range = input.ranges.find((range: any) =>
          range.path.endsWith(".bin"),
        );
        if (!range) return;
        reads.push({ path: range.path, offset: range.offset });
        representative ??= range.path;
        if (transition === "mid-read" && range.offset > 0 && !changed)
          await change();
        await new Promise((resolve) => setTimeout(resolve, 10));
      };
      b.before = async (method) => {
        if (
          transition === "between-slices" &&
          method === "scan" &&
          representative &&
          !changed
        )
          await change();
      };
      const final = await run.coordinator.sync("notes");
      expect(changed).toBe(true);
      const other = representative === "one.bin" ? "two.bin" : "one.bin";
      expect(
        reads.some((range) => range.path === other && range.offset === 0),
      ).toBe(true);
      for (const m of machines) {
        expect(sha(await readFile(join(m.root, representative!)))).toBe(
          sha(replacement),
        );
        expect(sha(await readFile(join(m.root, other)))).toBe(sha(original));
      }
      expect(final.nodes.every((node) => node.ready)).toBe(true);
      expect(final.openConflicts).toBe(0);
      expect(run.logs).toEqual([]);
      expect(await readdir(join(base, "blobs", "tmp"))).toEqual([]);
    },
  );

  it("preserves an unfinished upload when a peer edits the same path between slices", async () => {
    const a = await machine(base, "host-a");
    const b = await machine(base, "host-b");
    const machines = [a, b];
    await put(a, "keep.txt", "keep");
    const store = openStore(join(base, "hub.db"));
    const run = startCoordinator(store, machines, [folderOf(machines)], {
      sliceMs: 1,
    });
    stops.push(run.stop);
    await run.coordinator.sync("notes");
    const big = randomBytes(CHUNK_BYTES * 3 + 321);
    const peer = Buffer.from("peer edit during the large upload");
    await put(a, "binary.dat", big);
    const offsets: number[] = [];
    a.before = async (method, input) => {
      if (method !== "read") return;
      const range = input.ranges.find(
        (range: any) => range.path === "binary.dat",
      );
      if (!range) return;
      offsets.push(range.offset);
      if (offsets.length === 1) {
        await put(b, "binary.dat", peer);
        run.coordinator.onSignal(b.id, "notes", ["binary.dat"]);
      } else {
        expect(store.head("notes").get("binary.dat")?.content).toMatchObject({
          hash: sha(peer),
        });
        expect(sha(await readFile(join(a.root, "binary.dat")))).toBe(sha(big));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const final = await run.coordinator.sync("notes");
    expect(offsets).toEqual([0, CHUNK_BYTES, CHUNK_BYTES * 2, CHUNK_BYTES * 3]);
    for (const m of machines) {
      expect(await readFile(join(m.root, "binary.dat"))).toEqual(peer);
      const copies = conflictCopies(await readdir(m.root), "binary");
      expect(copies).toHaveLength(1);
      expect(sha(await readFile(join(m.root, copies[0]!)))).toBe(sha(big));
    }
    expect(final.nodes.every((node) => node.ready)).toBe(true);
    expect(final.openConflicts).toBe(1);
    expect(run.logs).toEqual([]);
    expect(await readdir(join(base, "blobs", "tmp"))).toEqual([]);
  });

  it.each(["pause", "exclude"] as const)(
    "aborts an in-flight upload on %s and restarts from zero after resuming",
    async (transition) => {
      const a = await machine(base, "host-a");
      const b = await machine(base, "host-b");
      const machines = [a, b];
      await put(a, "keep.txt", "keep");
      const folder = folderOf(machines);
      const store = openStore(join(base, "hub.db"));
      const run = startCoordinator(store, machines, [folder], { sliceMs: 1 });
      stops.push(run.stop);
      await run.coordinator.sync("notes");
      const big = randomBytes(CHUNK_BYTES * 2 + 321);
      await put(b, "binary.dat", big);
      const offsets: number[] = [];
      b.before = async (method, input) => {
        if (method !== "read") return;
        const range = input.ranges.find(
          (range: any) => range.path === "binary.dat",
        );
        if (!range) return;
        offsets.push(range.offset);
        await new Promise((resolve) => setTimeout(resolve, 40));
      };
      const barrier = run.coordinator.sync("notes").then(
        () => null,
        (error: unknown) => error,
      );
      await until(() => offsets.length > 0, "upload begins");
      expect(
        (await readdir(join(base, "blobs", "tmp"))).length,
      ).toBeGreaterThan(0);
      run.coordinator.apply({
        enabled: true,
        paused: transition === "pause",
        configError: null,
        folders: [
          {
            ...folder,
            ignorePaths: transition === "exclude" ? ["binary.dat"] : [],
          },
        ],
      });
      expect(await barrier).toMatchObject({
        message: "The sync configuration changed",
      });
      await until(
        async () => (await readdir(join(base, "blobs", "tmp"))).length === 0,
        "cancelled upload writer is removed",
      );
      expect(await store.hasBlob(sha(big))).toBe(false);
      expect(store.head("notes").has("binary.dat")).toBe(false);
      if (transition === "exclude") {
        const excluded = await run.coordinator.sync("notes");
        expect(excluded.nodes.every((node) => node.ready)).toBe(true);
        expect(await exists(join(a.root, "binary.dat"))).toBe(false);
      }
      run.coordinator.apply({
        enabled: true,
        paused: false,
        configError: null,
        folders: [folder],
      });
      const final = await run.coordinator.sync("notes");
      expect(offsets.slice(0, 2)).toEqual([0, 0]);
      expect(sha(await readFile(join(a.root, "binary.dat")))).toBe(sha(big));
      expect(final.nodes.every((node) => node.ready)).toBe(true);
      expect(final.openConflicts).toBe(0);
      expect(await readdir(join(base, "blobs", "tmp"))).toEqual([]);
    },
  );

  it("aborts a partial blob after a read failure and retries from zero", async () => {
    const a = await machine(base, "host-a");
    const b = await machine(base, "host-b");
    const machines = [a, b];
    await put(a, "keep.txt", "keep");
    const store = openStore(join(base, "hub.db"));
    const run = startCoordinator(store, machines, [folderOf(machines)], {
      sliceMs: 1,
    });
    stops.push(run.stop);
    await run.coordinator.sync("notes");
    const big = randomBytes(CHUNK_BYTES * 2 + 321);
    await put(b, "binary.dat", big);
    const offsets: number[] = [];
    let interrupted = false;
    const abandonedTemps: string[] = [];
    b.before = async (method, input) => {
      if (method !== "read") return;
      const range = input.ranges.find(
        (range: any) => range.path === "binary.dat",
      );
      if (!range) return;
      offsets.push(range.offset);
      if (offsets.length === 1)
        abandonedTemps.push(...(await readdir(join(base, "blobs", "tmp"))));
      if (!interrupted && range.offset > 0) {
        interrupted = true;
        throw new Error("Read transport interrupted");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    await expect(run.coordinator.sync("notes")).rejects.toThrow(
      /Read transport interrupted/,
    );
    expect(await store.hasBlob(sha(big))).toBe(false);
    expect(store.head("notes").has("binary.dat")).toBe(false);
    expect(abandonedTemps).toHaveLength(1);
    for (const temp of abandonedTemps)
      expect(await exists(join(base, "blobs", "tmp", temp))).toBe(false);
    const final = await run.coordinator.sync("notes");
    expect(offsets).toEqual([0, CHUNK_BYTES, 0, CHUNK_BYTES, CHUNK_BYTES * 2]);
    expect(sha(await readFile(join(a.root, "binary.dat")))).toBe(sha(big));
    expect(final.nodes.every((node) => node.ready)).toBe(true);
    expect(final.openConflicts).toBe(0);
    expect(await readdir(join(base, "blobs", "tmp"))).toEqual([]);
  });

  it("keeps primary seeding authority until its sliced uploads are complete", async () => {
    const a = await machine(base, "host-a");
    const b = await machine(base, "host-b");
    const machines = [a, b];
    const big = randomBytes(CHUNK_BYTES * 2 + 321);
    await put(a, "binary.dat", big);
    await put(b, "binary.dat", "divergent peer");
    const store = openStore(join(base, "hub.db"));
    let checked = false;
    a.before = async (method, input) => {
      if (method !== "read") return;
      const range = input.ranges.find(
        (range: any) => range.path === "binary.dat",
      );
      if (!range) return;
      if (range.offset > 0) {
        expect(store.isSeeded("notes")).toBe(false);
        expect(store.seq("notes")).toBe(0);
        expect(store.head("notes").has("binary.dat")).toBe(false);
        checked = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    b.before = (method) => {
      if (method === "scan") expect(store.isSeeded("notes")).toBe(true);
    };
    const run = startCoordinator(store, machines, [folderOf(machines)], {
      sliceMs: 1,
    });
    stops.push(run.stop);
    const final = await run.coordinator.sync("notes");
    expect(checked).toBe(true);
    for (const m of machines) {
      expect(sha(await readFile(join(m.root, "binary.dat")))).toBe(sha(big));
      const copies = conflictCopies(await readdir(m.root), "binary");
      expect(copies).toHaveLength(1);
      expect(await read(m, copies[0]!)).toBe("divergent peer");
    }
    expect(final.nodes.every((node) => node.ready)).toBe(true);
    expect(final.openConflicts).toBe(1);
    expect(await readdir(join(base, "blobs", "tmp"))).toEqual([]);
  });

  it.each(["lost-reply", "lost-commit-reply", "missing-temp"] as const)(
    "recovers a sliced download after %s without trusting an uncertain offset",
    async (failure) => {
      const a = await machine(base, "host-a");
      const b = await machine(base, "host-b");
      const machines = [a, b];
      await put(a, "keep.txt", "keep the root nonempty");
      const run = startCoordinator(
        openStore(join(base, "hub.db")),
        machines,
        [folderOf(machines)],
        { sliceMs: 1 },
      );
      stops.push(run.stop);
      await run.coordinator.sync("notes");
      const big = randomBytes(CHUNK_BYTES * 2 + 321);
      b.online = false;
      await until(
        () =>
          run.coordinator.status().folders[0]!.nodes[1]!.phase === "offline",
        "download target goes offline",
      );
      await put(a, "binary.dat", big);
      await run.coordinator.sync("notes", [a.id]);
      if (failure === "lost-reply")
        await put(
          b,
          "binary.dat",
          "local version preserved before interruption",
        );
      const chunks: { offset: number; tempId: string }[] = [];
      let interrupted = false;
      b.before = async (method, input) => {
        if (method !== "write") return;
        const chunk = input.items.find(
          (item: any) => item.path === "binary.dat",
        );
        if (!chunk) return;
        chunks.push({ offset: chunk.offset, tempId: chunk.tempId });
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (
          interrupted ||
          chunk.offset === 0 ||
          (failure === "lost-commit-reply" && chunk.commit === null)
        )
          return;
        interrupted = true;
        if (failure !== "missing-temp") {
          await b.harness.experimental_call("write", input);
          throw new Error("Lost chunk reply");
        }
        await unlink(join(b.root, `.bb-private-sync-${chunk.tempId}`));
      };
      b.online = true;
      await until(
        () =>
          run.coordinator.status().folders[0]!.nodes[1]!.phase !== "offline",
        "download target comes online",
      );
      await expect(run.coordinator.sync("notes")).rejects.toThrow(
        failure !== "missing-temp" ? /Lost chunk reply/ : /ENOENT/,
      );
      const final = await run.coordinator.sync("notes");
      expect(interrupted).toBe(true);
      expect(chunks.map((chunk) => chunk.offset)).toEqual(
        failure === "lost-commit-reply"
          ? [0, CHUNK_BYTES, CHUNK_BYTES * 2]
          : [0, CHUNK_BYTES, 0, CHUNK_BYTES, CHUNK_BYTES * 2],
      );
      if (failure !== "lost-commit-reply")
        expect(chunks[2]!.tempId).not.toBe(chunks[0]!.tempId);
      expect(sha(await readFile(join(b.root, "binary.dat")))).toBe(sha(big));
      expect(final.nodes.every((node) => node.ready)).toBe(true);
      expect(final.openConflicts).toBe(failure === "lost-reply" ? 1 : 0);
      if (failure === "lost-reply")
        for (const m of machines) {
          const copies = conflictCopies(await readdir(m.root), "binary");
          expect(copies).toHaveLength(1);
          expect(await read(m, copies[0]!)).toBe(
            "local version preserved before interruption",
          );
        }
    },
  );

  it.each(["replace", "delete", "local-edit"] as const)(
    "reconciles a %s between slices before resuming a download",
    async (change) => {
      const a = await machine(base, "host-a");
      const b = await machine(base, "host-b");
      const machines = [a, b];
      const original = randomBytes(CHUNK_BYTES * 2 + 321);
      const replacement = randomBytes(original.length);
      await put(a, "binary.dat", original);
      if (change === "replace") await put(a, "replacement.dat", replacement);
      await put(a, "keep.txt", "keep the root nonempty");
      const chunks: { offset: number; tempId: string }[] = [];
      let changed = false;
      let rescanned = false;
      const run = startCoordinator(
        openStore(join(base, "hub.db")),
        machines,
        [folderOf(machines)],
        { sliceMs: 1 },
      );
      stops.push(run.stop);
      b.before = async (method, input) => {
        if (method !== "write") return;
        const chunk = input.items.find(
          (item: any) => item.path === "binary.dat",
        );
        if (!chunk) return;
        chunks.push({ offset: chunk.offset, tempId: chunk.tempId });
        if (changed) {
          if (change === "local-edit" && !rescanned && chunk.offset > 0) {
            run.coordinator.onWorkerExit(b.id);
            rescanned = true;
          }
          return;
        }
        changed = true;
        if (change === "local-edit") {
          await put(b, "binary.dat", "typed locally during transfer");
          run.coordinator.onSignal(b.id, "notes", ["binary.dat"]);
        } else {
          if (change === "replace") await put(a, "binary.dat", replacement);
          else await unlink(join(a.root, "binary.dat"));
          run.coordinator.onSignal(a.id, "notes", ["binary.dat"]);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      };
      const final = await run.coordinator.sync("notes");
      expect(changed).toBe(true);
      expect(rescanned).toBe(change === "local-edit");
      if (change === "delete") {
        expect(chunks.map((chunk) => chunk.offset)).toEqual([0]);
        expect(await exists(join(b.root, "binary.dat"))).toBe(false);
      } else {
        expect(chunks.map((chunk) => chunk.offset)).toEqual([
          0,
          0,
          CHUNK_BYTES,
          CHUNK_BYTES * 2,
        ]);
        expect(new Set(chunks.map((chunk) => chunk.tempId)).size).toBe(1);
        const expected = change === "replace" ? replacement : original;
        for (const m of machines) {
          expect(sha(await readFile(join(m.root, "binary.dat")))).toBe(
            sha(expected),
          );
          if (change === "local-edit") {
            const copies = conflictCopies(await readdir(m.root), "binary");
            expect(copies).toHaveLength(1);
            expect(await read(m, copies[0]!)).toBe(
              "typed locally during transfer",
            );
          }
        }
      }
      expect(final.nodes.every((node) => node.ready)).toBe(true);
      expect(final.openConflicts).toBe(change === "local-edit" ? 1 : 0);
      expect(run.logs).toEqual([]);
    },
  );

  it("turns native watch events into root-relative signals and drops ignored paths", async () => {
    const a = await machine(base, "host-a");
    const watch = (
      folders: { folderId: string; root: string; ignorePaths: string[] }[],
    ) => a.harness.experimental_call("watch", { folders });
    await watch([
      { folderId: "notes", root: a.root, ignorePaths: ["private"] },
    ]);
    const listener = a.watchers[0]!;
    await listener({
      kind: "changed",
      changes: [
        { path: join(a.root, "x.md"), type: "update" },
        { path: join(a.root, "web/node_modules/y.js"), type: "create" },
        { path: join(a.root, "private/key"), type: "update" },
      ],
    });
    await listener({
      kind: "changed",
      changes: [{ path: join(a.root, ".git/index"), type: "update" }],
    });
    await listener({ kind: "rescan-required" });
    expect(a.harness.experimental_getSignals()).toEqual([
      { signal: "changed", payload: { folderId: "notes", paths: ["x.md"] } },
      { signal: "changed", payload: { folderId: "notes", paths: null } },
    ]);
    await watch([]);
    expect(a.watchers).toHaveLength(0);
  });

  it("retries every file sharing bytes with a file that changed mid-read", async () => {
    const { machines, coordinator } = await setup(2);
    const [a, b] = machines as [Machine, Machine];
    await coordinator.sync("notes");
    await put(a, "a.txt", "same bytes");
    await put(a, "b.txt", "same bytes");
    await put(a, "c.txt", "unrelated");
    // Only one of the twins is read for their shared hash; change that one while it is read.
    let touched: string | null = null;
    a.before = async (method, input) => {
      if (method !== "read" || touched) return;
      const twin = input.ranges.find((range: any) => range.path !== "c.txt");
      if (!twin) return;
      touched = twin.path as string;
      await put(a, touched, "edited while read");
    };
    const status = await coordinator.sync("notes");
    expect(touched).not.toBeNull();
    const other = touched === "a.txt" ? "b.txt" : "a.txt";
    expect(await read(b, touched!)).toBe("edited while read");
    expect(await read(b, other)).toBe("same bytes");
    expect(await read(b, "c.txt")).toBe("unrelated");
    expect(status.nodes.map((node) => [node.phase, node.error])).toEqual([
      ["ready", null],
      ["ready", null],
    ]);
  });

  it("refuses hub-only writes after a wipe with no watcher signal, before a full scan can spread tombstones", async () => {
    const { machines, coordinator, store } = await setup(2, async ([a]) => {
      await put(a!, "keep.txt", "keep");
      await put(a!, "original.txt", "original bytes");
    });
    const [a, b] = machines as [Machine, Machine];
    await coordinator.sync("notes");
    await rm(b.root, { recursive: true });
    await mkdir(b.root);
    let probed = false;
    b.before = (method, input) => {
      if (method === "scan" && input.paths?.length === 0) probed = true;
    };
    await put(a, "new.txt", "hub addition after the lost watcher event");
    coordinator.onSignal(a.id, "notes", ["new.txt"]);
    await coordinator.sync("notes", [a.id]);
    const seq = store.seq("notes");
    await until(() => {
      const node = coordinator.status().folders[0]!.nodes[1]!;
      return node.phase === "error" || node.ackedVersion >= seq;
    }, "wiped node settles its hub-only pass");
    expect(coordinator.status().folders[0]!.nodes[1]).toMatchObject({
      phase: "error",
      ready: false,
    });
    expect(probed).toBe(true);
    expect(await readdir(b.root)).toEqual([]);
    await expect(coordinator.sync("notes", [b.id])).rejects.toThrow(/empty/);
    expect(store.seq("notes")).toBe(seq);
    expect(store.head("notes").get("original.txt")?.content?.kind).toBe("file");
    expect(store.node("notes", b.id).acked).toBeLessThan(seq);
    expect(await read(a, "original.txt")).toBe("original bytes");
    expect(await read(a, "keep.txt")).toBe("keep");
    expect(coordinator.status().folders[0]!.nodes[1]!.ready).toBe(false);
  });

  it("refuses a wiped root even when the watcher only reports the deleted paths", async () => {
    const { machines, coordinator } = await setup(2, async ([a]) => {
      await put(a!, "one.md", "1");
      await put(a!, "two.md", "2");
      await put(a!, "three.md", "3");
    });
    const [a, b] = machines as [Machine, Machine];
    await coordinator.sync("notes");
    const node = () => coordinator.status().folders[0]!.nodes[1]!;

    // A real delete with the rest of the root intact still propagates.
    await unlink(join(b.root, "three.md"));
    coordinator.onSignal(b.id, "notes", ["three.md"]);
    await coordinator.sync("notes", [a.id]);
    await until(
      async () => !(await exists(join(a.root, "three.md"))),
      "delete reaches a",
    );
    const before = coordinator.status().folders[0]!.headVersion;

    for (const name of ["one.md", "two.md"]) await unlink(join(b.root, name));
    coordinator.onSignal(b.id, "notes", ["one.md", "two.md"]);
    await until(() => node().phase === "error", "b refuses");
    expect(node().error).toMatch(/empty/);
    expect(await read(a, "one.md")).toBe("1");
    expect(await read(a, "two.md")).toBe("2");
    expect(coordinator.status().folders[0]!.headVersion).toBe(before);
  });

  it("never downloads or deletes a path once it is excluded, even for a new machine", async () => {
    const machines = [
      await machine(base, "host-a"),
      await machine(base, "host-b"),
      await machine(base, "host-c"),
    ];
    const [a, b, c] = machines as [Machine, Machine, Machine];
    await put(a, "private/token", "secret-a");
    await put(a, "note.md", "shared");
    const store = openStore(join(base, "hub.db"));
    const run = startCoordinator(store, machines, [folderOf([a, b])]);
    stops.push(run.stop);
    await run.coordinator.sync("notes");
    expect(await read(b, "private/token")).toBe("secret-a");

    // Exclude the token, add c, and take the primary offline: only the hub's stored copy could reach c.
    a.online = false;
    run.coordinator.apply({
      enabled: true,
      paused: false,
      configError: null,
      folders: [folderOf(machines, { ignorePaths: ["private"] })],
    });
    await until(
      () => run.coordinator.status().folders[0]!.nodes[0]!.phase === "offline",
      "a offline",
    );
    await put(b, "private/token", "rotated on b");
    await run.coordinator.sync("notes", [b.id, c.id]);
    expect(await read(c, "note.md")).toBe("shared");
    expect(await exists(join(c.root, "private"))).toBe(false);
    expect(await read(b, "private/token")).toBe("rotated on b");

    a.online = true;
    await until(
      () => run.coordinator.status().folders[0]!.nodes[0]!.phase !== "offline",
      "a online",
    );
    await run.coordinator.sync("notes");
    expect(await read(a, "private/token")).toBe("secret-a");
    expect(await read(b, "private/token")).toBe("rotated on b");
    expect(await exists(join(c.root, "private"))).toBe(false);
  });

  it("treats a missing or emptied root as an error, never as mass deletion", async () => {
    const { machines, coordinator } = await setup(2, async ([a]) => {
      await put(a!, "one.md", "1");
      await put(a!, "two.md", "2");
    });
    const [a, b] = machines as [Machine, Machine];
    const synced = await coordinator.sync("notes");

    await rm(b.root, { recursive: true });
    await expect(coordinator.sync("notes", [b.id])).rejects.toThrow(/missing/);
    expect(coordinator.status().folders[0]!.nodes[1]).toMatchObject({
      phase: "error",
      ready: false,
    });

    await mkdir(b.root);
    await expect(coordinator.sync("notes", [b.id])).rejects.toThrow(/empty/);
    expect(await read(a, "one.md")).toBe("1");
    expect(await read(a, "two.md")).toBe("2");
    expect(coordinator.status().folders[0]!.headVersion).toBe(
      synced.headVersion,
    );
  });
});
