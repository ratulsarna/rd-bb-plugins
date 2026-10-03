import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Content } from "../contract";
import {
  HashCache,
  commitFile,
  removePath,
  scanRoot,
  writeChunk,
  writeLink,
} from "../lib/host-fs";
import { TEMP_PREFIX } from "../lib/paths";

const hooks = vi.hoisted(() => ({
  before: undefined as
    ((op: string, args: unknown[]) => Promise<void>) | undefined,
  after: undefined as
    ((op: string, args: unknown[]) => Promise<void>) | undefined,
  writeLimit: null as number | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const intercepted = Object.fromEntries(
    (["rename", "link", "symlink", "unlink"] as const).map((op) => [
      op,
      async (...args: unknown[]) => {
        await hooks.before?.(op, args);
        await (fs[op] as (...args: unknown[]) => Promise<void>)(...args);
        await hooks.after?.(op, args);
      },
    ]),
  );
  return {
    ...fs,
    ...intercepted,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const write = handle.write.bind(handle);
      handle.write = ((
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) =>
        write(
          buffer,
          offset,
          Math.min(length, hooks.writeLimit ?? length),
          position,
        )) as typeof handle.write;
      return handle;
    },
  };
});

const fs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const file = (
  bytes: string,
  exec = false,
): Extract<Content, { kind: "file" }> => ({
  kind: "file",
  hash: createHash("sha256").update(bytes).digest("hex"),
  size: Buffer.byteLength(bytes),
  exec,
});

let base: string;
let root: string;
let target: string;
let cache: HashCache;
beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), "private-sync-host-"));
  root = join(base, "root");
  await fs.mkdir(root);
  target = join(root, "doc.md");
  cache = new HashCache(join(base, "data", "hashes.json"));
});
afterEach(async () => {
  hooks.before = hooks.after = undefined;
  hooks.writeLimit = null;
  await fs.rm(base, { recursive: true, force: true });
});

async function save(bytes: string) {
  const temp = join(root, ".editor-save");
  await fs.writeFile(temp, bytes);
  await fs.rename(temp, target);
}

async function apply(
  kind: "file" | "link" | "remove",
  expected: Content | null,
) {
  const request = { root, path: "doc.md", expected };
  if (kind === "link")
    return writeLink(cache, { ...request, target: "other.md" });
  if (kind === "remove")
    return removePath(cache, { ...request, expected: expected! });
  await writeChunk({
    ...request,
    tempId: "incoming123",
    offset: 0,
    data: Buffer.from("remote").toString("base64"),
  });
  return commitFile(cache, {
    ...request,
    tempId: "incoming123",
    content: file("remote"),
  });
}

function mutatesTarget(op: string, args: unknown[]) {
  return (
    (op === "rename" && (args[0] === target || args[1] === target)) ||
    (op === "unlink" && args[0] === target) ||
    ((op === "link" || op === "symlink") && args[1] === target)
  );
}

async function copies() {
  const paths = (await fs.readdir(root)).filter((path) =>
    path.includes(".sync-conflict-"),
  );
  return Promise.all(
    paths.map((path) => fs.readFile(join(root, path), "utf8")),
  );
}

describe("filesystem mutation interleavings", () => {
  it.each(["file", "link", "remove"] as const)(
    "%s preserves a save immediately before the destructive syscall",
    async (kind) => {
      await save("expected");
      let injected = false;
      hooks.before = async (op, args) => {
        if (injected || !mutatesTarget(op, args)) return;
        injected = true;
        await save("editor latest");
      };
      expect(await apply(kind, file("expected"))).toEqual({
        ok: false,
        reason: "local-changed",
      });
      expect(injected).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe("editor latest");
      expect(await copies()).toContain("editor latest");
    },
  );

  it.each(["file", "link", "remove"] as const)(
    "%s retains the captured save when a second atomic save lands after capture",
    async (kind) => {
      await save("expected");
      let captured = false;
      let second = false;
      hooks.before = async (op, args) => {
        if (captured || !mutatesTarget(op, args)) return;
        captured = true;
        await save("first editor save");
      };
      hooks.after = async (op, args) => {
        if (second || !mutatesTarget(op, args)) return;
        second = true;
        await save("second editor save");
      };
      expect(await apply(kind, file("expected"))).toEqual({
        ok: false,
        reason: "local-changed",
      });
      expect(captured && second).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe("second editor save");
      expect(await copies()).toContain("first editor save");
      const scanned = await scanRoot(cache, {
        root,
        ownDirs: [join(base, "data")],
        ignorePaths: [],
      });
      expect(
        scanned.ok &&
          scanned.entries.some(
            (entry) =>
              entry.kind === "file" &&
              entry.hash === file("first editor save").hash,
          ),
      ).toBe(true);
      expect(
        (await fs.readdir(root)).some((path) => path.startsWith(TEMP_PREFIX)),
      ).toBe(false);
    },
  );

  it.each(["file", "link"] as const)(
    "%s publication cannot overwrite a save after a verified capture",
    async (kind) => {
      await save("expected");
      let injected = false;
      hooks.before = async (op, args) => {
        if (
          injected ||
          args[1] !== target ||
          !["link", "symlink", "rename"].includes(op)
        )
          return;
        injected = true;
        await save("save at publication");
      };
      expect(await apply(kind, file("expected"))).toEqual({
        ok: false,
        reason: "local-changed",
      });
      expect(injected).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe("save at publication");
    },
  );

  it.each(["file", "link"] as const)(
    "%s creation cannot overwrite a save to an initially absent path",
    async (kind) => {
      let injected = false;
      hooks.before = async (op, args) => {
        if (injected || !mutatesTarget(op, args)) return;
        injected = true;
        await save("new local file");
      };
      expect(await apply(kind, null)).toEqual({
        ok: false,
        reason: "local-changed",
      });
      expect(injected).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe("new local file");
    },
  );

  it("restoration cannot destroy a second save and conflict-name collisions preserve every version", async () => {
    await save("expected");
    let captured = false;
    let restoring = false;
    let collision = false;
    hooks.before = async (op, args) => {
      if (!captured && op === "rename" && args[0] === target) {
        captured = true;
        await save("captured edit");
      }
      if (
        !collision &&
        op === "link" &&
        String(args[1]).includes(".sync-conflict-")
      ) {
        collision = true;
        await fs.writeFile(String(args[1]), "existing conflict", {
          flag: "wx",
        });
      }
      if (!restoring && op === "link" && args[1] === target) {
        restoring = true;
        await save("newest edit");
      }
    };
    expect(await apply("file", file("expected"))).toEqual({
      ok: false,
      reason: "local-changed",
    });
    expect(captured && restoring && collision).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("newest edit");
    expect(await copies()).toEqual(
      expect.arrayContaining(["existing conflict", "captured edit"]),
    );
  });

  it("restores expected bytes when publication fails, without leaving a stale recovery directory", async () => {
    await save("expected");
    hooks.before = async (op, args) => {
      if (
        op === "link" &&
        args[1] === target &&
        !String(args[0]).includes("capture-")
      )
        throw Object.assign(new Error("disk failure"), { code: "EIO" });
    };
    await expect(apply("file", file("expected"))).rejects.toThrow(
      "disk failure",
    );
    expect(await fs.readFile(target, "utf8")).toBe("expected");
    expect(await fs.readdir(root)).toEqual(["doc.md"]);
  });

  it("removes only the captured entry when an editor recreates a deleted path", async () => {
    await save("expected");
    let saved = false;
    hooks.after = async (op, args) => {
      if (!saved && op === "rename" && args[0] === target) {
        saved = true;
        await save("new file during deletion");
      }
    };
    expect(await apply("remove", file("expected"))).toEqual({ ok: true });
    expect(saved).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("new file during deletion");
  });

  it("preserves a captured symlink itself while retaining a second save at the target", async () => {
    await save("expected");
    await fs.writeFile(join(root, "local.md"), "symlink contents");
    let captured = false;
    let saved = false;
    hooks.before = async (op, args) => {
      if (captured || op !== "rename" || args[0] !== target) return;
      captured = true;
      const editor = join(root, ".editor-link");
      await fs.symlink("local.md", editor);
      await fs.rename(editor, target);
    };
    hooks.after = async (op, args) => {
      if (saved || op !== "rename" || args[0] !== target) return;
      saved = true;
      await save("second save");
    };
    expect(await apply("file", file("expected"))).toEqual({
      ok: false,
      reason: "local-changed",
    });
    const [copy] = (await fs.readdir(root)).filter((path) =>
      path.includes(".sync-conflict-"),
    );
    expect(await fs.readlink(join(root, copy!))).toBe("local.md");
    expect(await fs.readFile(join(root, copy!), "utf8")).toBe(
      "symlink contents",
    );
    expect(await fs.readFile(target, "utf8")).toBe("second save");
  });

  it("recovers a failed capture before a later download can mistake it for an absent target", async () => {
    await save("expected");
    let captured = false;
    hooks.before = async (op, args) => {
      if (!captured && op === "rename" && args[0] === target) {
        captured = true;
        await save("retained edit");
      }
      if (op === "link" && String(args[1]).includes(".sync-conflict-"))
        throw Object.assign(new Error("recovery unavailable"), { code: "EIO" });
    };
    await expect(apply("file", file("expected"))).rejects.toThrow(
      "recovery unavailable",
    );
    expect(await fs.stat(target).catch(() => null)).toBeNull();
    hooks.before = undefined;
    expect(await apply("file", null)).toEqual({
      ok: false,
      reason: "local-changed",
    });
    expect(await fs.readFile(target, "utf8")).toBe("retained edit");
    expect(await copies()).toContain("retained edit");
    expect(
      (await fs.readdir(root)).some((path) => path.startsWith(TEMP_PREFIX)),
    ).toBe(false);
  });

  it("loops over native partial writes across chunks and verifies the complete file before replacement", async () => {
    await save("expected");
    hooks.writeLimit = 7;
    const bytes = "abc\u0000def".repeat(180);
    const prefix = bytes.slice(0, 333);
    for (const [offset, part] of [
      [0, prefix],
      [prefix.length, bytes.slice(prefix.length)],
    ] as const)
      expect(
        await writeChunk({
          root,
          path: "doc.md",
          tempId: "partial123",
          offset,
          data: Buffer.from(part).toString("base64"),
        }),
      ).toEqual({ ok: true });
    expect(
      await commitFile(cache, {
        root,
        path: "doc.md",
        tempId: "partial123",
        content: file(bytes, true),
        expected: file("expected"),
      }),
    ).toEqual({ ok: true });
    expect(await fs.readFile(target, "utf8")).toBe(bytes);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    expect(
      await writeLink(cache, {
        root,
        path: "doc.md",
        target: "other.md",
        expected: file(bytes, true),
      }),
    ).toEqual({ ok: true });
    expect(await fs.readlink(target)).toBe("other.md");
    expect(
      await apply("file", { kind: "symlink", target: "other.md" }),
    ).toEqual({ ok: true });
    expect(await fs.readFile(target, "utf8")).toBe("remote");
    expect(await apply("remove", file("remote"))).toEqual({ ok: true });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("fails a zero-progress native write without changing the existing file", async () => {
    await save("expected");
    hooks.writeLimit = 0;
    await expect(apply("file", file("expected"))).rejects.toThrow(
      "no progress",
    );
    expect(await fs.readFile(target, "utf8")).toBe("expected");
  });

  it("waits for an active capture before scanning the temporarily absent target", async () => {
    await save("expected");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      entered = resolve;
    });
    hooks.after = async (op, args) => {
      if (op === "rename" && args[0] === target) {
        entered();
        await gate;
      }
    };
    const changing = apply("file", file("expected"));
    await captured;
    let finished = false;
    const scanning = scanRoot(cache, {
      root,
      ownDirs: [],
      ignorePaths: [],
    }).then((result) => {
      finished = true;
      return result;
    });
    await new Promise(setImmediate);
    expect(finished).toBe(false);
    release();
    expect(await changing).toEqual({ ok: true });
    const scanned = await scanning;
    expect(
      scanned.ok &&
        scanned.entries.some(
          (entry) =>
            entry.kind === "file" &&
            entry.path === "doc.md" &&
            entry.hash === file("remote").hash,
        ),
    ).toBe(true);
  });

  it.each([false, true])(
    "recovers a SIGKILL after real capture before scanning (new target: %s)",
    async (newTarget) => {
      const child = fork(
        fileURLToPath(
          new URL("../node_modules/vite-node/vite-node.mjs", import.meta.url),
        ),
        [
          "--script",
          fileURLToPath(new URL("./host-capture-child.ts", import.meta.url)),
        ],
        {
          env: { ...process.env, CAPTURE_TEST_ROOT: root },
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += chunk;
      });
      try {
        await Promise.race([
          once(child, "message").then(([message]) =>
            expect(message).toBe("captured"),
          ),
          once(child, "exit").then(([code]) => {
            throw new Error(`child exited ${code}: ${stderr}`);
          }),
        ]);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        expect(await fs.stat(target).catch(() => null)).toBeNull();
        if (newTarget) await save("newer editor save after process death");
        const freshCache = new HashCache(
          join(base, "fresh-data", "hashes.json"),
        );
        const result = await scanRoot(freshCache, {
          root,
          paths: newTarget ? ["doc.md"] : [],
          ownDirs: [],
          ignorePaths: [],
          now: Date.now() + 2 * 60 * 60_000,
        });
        expect(result.ok).toBe(true);
        expect(result.ok && result.empty).toBe(false);
        expect(await fs.readFile(target, "utf8")).toBe(
          newTarget
            ? "newer editor save after process death"
            : "editor bytes captured before process death",
        );
        expect(await copies()).toContain(
          "editor bytes captured before process death",
        );
        expect(
          (await fs.readdir(root)).some((path) =>
            path.startsWith(`${TEMP_PREFIX}capture-`),
          ),
        ).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});

describe("scan root filesystem identity", () => {
  it.each(["root", "ancestor", "owned-alias", "missing-owned-child"] as const)(
    "rejects plugin metadata via %s aliases",
    async (alias) => {
      const data = join(base, "data");
      await fs.mkdir(join(data, "child"), { recursive: true });
      await fs.writeFile(join(data, "metadata.json"), "private metadata");
      const shortcut = join(base, "alias");
      await fs.symlink(data, shortcut);
      const options = {
        root:
          alias === "ancestor"
            ? join(shortcut, "child")
            : alias === "owned-alias"
              ? data
              : shortcut,
        ownDirs: [
          alias === "owned-alias"
            ? shortcut
            : alias === "missing-owned-child"
              ? join(data, "future", "cache")
              : data,
        ],
        ignorePaths: [],
      };
      expect(await scanRoot(cache, options)).toEqual({
        ok: false,
        reason: "unsafe-root",
      });
    },
  );

  it("scans safe real and aliased roots without walking symlinks inside them", async () => {
    await fs.writeFile(target, "safe");
    const outside = join(base, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, "secret"), "unrelated bytes");
    await fs.symlink(outside, join(root, "escape"));
    await fs.symlink("doc.md", join(root, "portable"));
    const alias = join(base, "safe-alias");
    await fs.symlink(root, alias);
    for (const path of [root, alias]) {
      const result = await scanRoot(cache, {
        root: path,
        ownDirs: [join(base, "data")],
        ignorePaths: [],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("safe root rejected");
      expect(result.entries.map((entry) => entry.path).sort()).toEqual([
        "doc.md",
        "portable",
      ]);
      expect(result.skipped).toBe(1);
    }
  });
});
