import { createHash } from "node:crypto";
import { constants, mkdtempSync, type Stats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  readFile,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { conflictPath } from "./conflict-path";
import {
  sameContent,
  sameRoot,
  type RootIdentity,
  type ApplyResult,
  type Content,
  type ScanEntry,
} from "../contract";
import {
  TEMP_PREFIX,
  isIgnored,
  isSafeRelativePath,
  isSafeSymlinkTarget,
  isWithin,
} from "./paths";

/** Leftover temporary files older than this belong to a dead writer. */
const STALE_TEMP_MS = 60 * 60_000;
const HASH_ATTEMPTS = 3;
const CAPTURE_PREFIX = `${TEMP_PREFIX}capture-`;
const activeCaptures = new Map<string, Promise<void>>();

const ok: ApplyResult = { ok: true };
const localChanged: ApplyResult = { ok: false, reason: "local-changed" };
const blocked: ApplyResult = { ok: false, reason: "blocked" };

function signature(stats: Stats): string {
  return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;
}

function sameFile(a: Stats, b: Stats): boolean {
  return signature(a) === signature(b);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR")
      return null;
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/**
 * Content hashes keyed by a stat signature (size, mtime, ctime, inode), so an
 * unchanged file is never read twice. Persisted per root in the host data dir.
 */
export class HashCache {
  private entries = new Map<string, [string, string]>();
  private loaded = false;

  constructor(private readonly file: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (Array.isArray(parsed))
        for (const row of parsed)
          if (
            Array.isArray(row) &&
            row.length === 3 &&
            row.every((v) => typeof v === "string")
          )
            this.entries.set(row[0], [row[1], row[2]]);
    } catch {
      // A missing or unreadable cache only costs a rehash.
    }
  }

  /** Hash a regular file, or null when it keeps changing while being read. */
  async hash(
    relPath: string,
    absPath: string,
    stats: Stats,
  ): Promise<{ hash: string; stats: Stats } | null> {
    await this.load();
    let current = stats;
    for (let attempt = 0; attempt < HASH_ATTEMPTS; attempt += 1) {
      const cached = this.entries.get(relPath);
      if (cached && cached[0] === signature(current))
        return { hash: cached[1], stats: current };
      const hash = await hashFile(absPath);
      const after = await lstat(absPath);
      if (after.isFile() && sameFile(current, after)) {
        this.entries.set(relPath, [signature(after), hash]);
        return { hash, stats: after };
      }
      if (!after.isFile()) return null;
      current = after;
    }
    return null;
  }

  /** Keep only `paths` and write the cache atomically. */
  async save(paths: ReadonlySet<string>): Promise<void> {
    for (const key of this.entries.keys())
      if (!paths.has(key)) this.entries.delete(key);
    const rows = [...this.entries].map(([path, [sig, hash]]) => [
      path,
      sig,
      hash,
    ]);
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(rows));
    await rename(temp, this.file);
  }
}

export interface ScanOptions {
  root: string;
  ignorePaths: readonly string[];
  /** Restrict the walk to these root-relative paths and their subtrees. */
  paths?: readonly string[];
  /** Every other configured folder root on this host, including offline mappings. */
  otherRoots?: readonly string[];
  identity?: RootIdentity | null;
  /** Directories the plugin itself owns on this host; never inside a root. */
  ownDirs: readonly string[];
  now?: number;
}

export type ScanOutcome =
  | { ok: true; identity: RootIdentity; entries: ScanEntry[]; skipped: number; empty: boolean }
  | {
      ok: false;
      reason: "root-missing" | "unsafe-root" | "root-changed" | "overlapping-roots";
    };

/** Owned directories may not exist until the first cache write. */
async function resolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR")
      throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await resolvedPath(parent), posix.basename(path));
  }
}

const ROOT_CHANGED = "Folder root identity changed. Restore the original directory or explicitly change the mapped path.";

interface BoundRoot {
  root: string;
  identity: RootIdentity;
}

async function directoryIdentity(path: string): Promise<RootIdentity | null> {
  try {
    const canonical = await realpath(path);
    const stats = await lstat(canonical, { bigint: true });
    return stats.isDirectory()
      ? { canonical, dev: String(stats.dev), ino: String(stats.ino) }
      : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(errorCode(error) ?? "")) return null;
    throw error;
  }
}

/** Cleanup may use the original canonical directory even after its configured alias changes. */
async function canonicalMatches(identity: RootIdentity): Promise<boolean> {
  const current = await directoryIdentity(identity.canonical);
  return current !== null && sameRoot(current, identity);
}

export async function requireRoot(request: BoundRoot): Promise<string> {
  const current = await directoryIdentity(request.root);
  if (!current || !sameRoot(current, request.identity)) throw new Error(ROOT_CHANGED);
  return request.identity.canonical;
}

/**
 * Walk a root without following symlinks. Every read error other than a path
 * vanishing mid-walk fails the scan: an unreadable directory must never look
 * like deleted files.
 */
export async function scanRoot(
  cache: HashCache,
  options: ScanOptions,
): Promise<ScanOutcome> {
  const { ignorePaths } = options;
  const configured = [options.root, ...(options.otherRoots ?? [])];
  const facts = async () => Promise.all(configured.map(async (path) => {
    const canonical = await resolvedPath(path);
    return { canonical, stats: await lstatOrNull(canonical) };
  }));
  const before = await facts();
  const { canonical: root, stats: rootStats } = before[0]!;
  if (!rootStats?.isDirectory()) return { ok: false, reason: "root-missing" };
  const identity = await directoryIdentity(options.root);
  if (!identity || identity.canonical !== root ||
      (options.identity && !sameRoot(identity, options.identity)))
    return { ok: false, reason: "root-changed" };
  for (const [index, entry] of before.entries())
    if (before.slice(0, index).some((other) =>
      isWithin(entry.canonical, other.canonical) ||
      isWithin(other.canonical, entry.canonical),
    ))
      return { ok: false, reason: "overlapping-roots" };
  // Directory edits change mtime; only canonical location and identity define this root.
  const stable = async () => await canonicalMatches(identity) &&
    (await facts()).every((entry, index) => {
    const original = before[index]!;
    return entry.canonical === original.canonical &&
      entry.stats?.dev === original.stats?.dev &&
      entry.stats?.ino === original.stats?.ino &&
      entry.stats?.isDirectory() === original.stats?.isDirectory();
  });
  const ownDirs = await Promise.all(options.ownDirs.map(resolvedPath));
  if (
    root === "/" ||
    ownDirs.some(
      (dir) => dir === "/" || isWithin(dir, root) || isWithin(root, dir),
    )
  )
    return { ok: false, reason: "unsafe-root" };

  const now = options.now ?? Date.now();
  const entries: ScanEntry[] = [];
  let skipped = 0;

  const visit = async (rel: string, stats: Stats): Promise<void> => {
    if (stats.isDirectory()) {
      let names: string[];
      try {
        names = await recoveredNames(root, rel);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      for (const name of names) {
        const child = `${rel === "" ? "" : `${rel}/`}${name}`;
        if (name.startsWith(TEMP_PREFIX)) {
          const temp = await lstatOrNull(join(root, child));
          if (temp?.isFile() && now - temp.mtimeMs > STALE_TEMP_MS)
            await unlink(join(root, child)).catch(() => {});
          continue;
        }
        if (!isSafeRelativePath(child) || isIgnored(child, ignorePaths))
          continue;
        const childStats = await lstatOrNull(join(root, child));
        if (childStats) await visit(child, childStats);
      }
    } else if (stats.isSymbolicLink()) {
      const target = await mirroredLink(root, rel);
      if (target !== null)
        entries.push({ kind: "symlink", path: rel, target });
      else skipped += 1;
    } else if (stats.isFile()) {
      let hashed: Awaited<ReturnType<HashCache["hash"]>>;
      try {
        hashed = await cache.hash(rel, join(root, rel), stats);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      if (hashed === null) entries.push({ kind: "busy", path: rel });
      else
        entries.push({
          kind: "file",
          path: rel,
          hash: hashed.hash,
          size: hashed.stats.size,
          exec: (hashed.stats.mode & 0o100) !== 0,
          mtimeMs: hashed.stats.mtimeMs,
        });
    } else {
      skipped += 1;
    }
  };

  if (options.paths === undefined) {
    await visit("", rootStats);
    if (!(await stable())) return { ok: false, reason: "root-changed" };
    await cache.save(new Set(entries.map((entry) => entry.path)));
    if (!(await stable())) return { ok: false, reason: "root-changed" };
    return { ok: true, identity, entries, skipped, empty: entries.length === 0 };
  }
  for (const path of options.paths) {
    if (isIgnored(path, ignorePaths)) continue;
    const parent = await walkParents(root, path, false);
    if (parent !== "ok") continue;
    await recoveredNames(
      root,
      posix.dirname(path) === "." ? "" : posix.dirname(path),
    ).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    const stats = await lstatOrNull(join(root, path));
    if (stats) await visit(path, stats);
  }
  const empty =
    entries.length === 0 && !(await holdsMirrored(root, "", ignorePaths));
  if (!(await stable())) return { ok: false, reason: "root-changed" };
  return { ok: true, identity, entries, skipped, empty };
}

async function mirroredLink(root: string, path: string): Promise<string | null> {
  const target = await readlink(join(root, path)).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  return target !== null && isSafeSymlinkTarget(path, target) ? target : null;
}

/** Whether anything mirrored remains under `rel`; stops at the first file or link. */
async function holdsMirrored(
  root: string,
  rel: string,
  ignorePaths: readonly string[],
): Promise<boolean> {
  const names = await recoveredNames(root, rel).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  for (const name of names) {
    const child = rel === "" ? name : `${rel}/${name}`;
    if (!isSafeRelativePath(child) || isIgnored(child, ignorePaths)) continue;
    const stats = await lstatOrNull(join(root, child));
    if (stats?.isFile()) return true;
    if (stats?.isSymbolicLink() && (await mirroredLink(root, child)) !== null)
      return true;
    if (stats?.isDirectory() && (await holdsMirrored(root, child, ignorePaths)))
      return true;
  }
  return false;
}

/**
 * Check every directory between the root and `path`. A symlink or file in the
 * way means the path lies outside the mirrored tree; `create` makes missing ones.
 */
async function walkParents(
  root: string,
  path: string,
  create: boolean,
): Promise<"ok" | "missing" | "blocked"> {
  const segments = path.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stats = await lstatOrNull(current);
    if (stats === null) {
      if (!create) return "missing";
      await mkdir(current).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      const made = await lstat(current);
      if (!made.isDirectory()) return "blocked";
    } else if (!stats.isDirectory()) {
      return "blocked";
    }
  }
  return "ok";
}

function requireSafe(path: string): void {
  if (!isSafeRelativePath(path))
    throw new Error("Refusing an unsafe relative path");
}

/** The path's current content, `null` when absent, `blocked` for a directory or special file. */
async function currentContent(
  cache: HashCache,
  root: string,
  path: string,
): Promise<Content | null | "blocked"> {
  const abs = join(root, path);
  const stats = await lstatOrNull(abs);
  if (stats === null) return null;
  if (stats.isSymbolicLink())
    return { kind: "symlink", target: await readlink(abs) };
  if (!stats.isFile()) return "blocked";
  const hashed = await cache.hash(path, abs, stats);
  // A file still being written cannot match anything we expect.
  if (hashed === null)
    return { kind: "file", hash: "", size: stats.size, exec: false };
  return {
    kind: "file",
    hash: hashed.hash,
    size: hashed.stats.size,
    exec: (hashed.stats.mode & 0o100) !== 0,
  };
}

/** Check parents and the expected current content before replacing or removing a path. */
async function guard(
  cache: HashCache,
  root: string,
  path: string,
  expected: Content | null,
  create: boolean,
): Promise<ApplyResult> {
  requireSafe(path);
  const parents = await walkParents(root, path, create);
  if (parents === "blocked") return blocked;
  if (parents === "missing") return expected === null ? ok : localChanged;
  await recoveredNames(
    root,
    posix.dirname(path) === "." ? "" : posix.dirname(path),
  );
  const current = await currentContent(cache, root, path);
  if (current === "blocked") return blocked;
  return sameContent(current, expected) ? ok : localChanged;
}

/** Exclusive copies preserve symlinks themselves on both Darwin and Linux. */
async function publishCaptured(
  captured: string,
  destination: string,
): Promise<void> {
  const stats = await lstat(captured);
  if (stats.isSymbolicLink())
    await symlink(await readlink(captured), destination);
  else if (stats.isFile()) await link(captured, destination);
  else throw new Error(`Cannot recover a non-file capture: ${captured}`);
}

/** Keep captured edits visible to the next scan, without replacing an existing copy. */
async function preserveCaptured(
  root: string,
  path: string,
  captured: string,
): Promise<void> {
  const at = new Date();
  for (let attempt = 0; ; attempt += 1) {
    const copy = join(root, conflictPath(path, "local", at, attempt));
    try {
      await publishCaptured(captured, copy);
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
}

/** Move opaque entries into an exclusively owned visible container; never traverse or overwrite them. */
async function preserveOpaque(
  root: string,
  path: string,
  captured: string,
): Promise<boolean> {
  const stats = await lstat(captured);
  if (stats.isFile() || stats.isSymbolicLink()) return false;
  const container = mkdtempSync(
    `${join(root, conflictPath(path, "local", new Date(), 0, 7))}-`,
  );
  try {
    await rename(captured, join(container, posix.basename(path)));
  } catch (error) {
    await rmdir(container);
    throw error;
  }
  return true;
}

/** A capture's single entry carries its original basename, including after a restart. */
async function recoveredNames(root: string, rel: string): Promise<string[]> {
  const dir = join(root, rel);
  const names = await readdir(dir);
  let recovered = false;
  for (const name of names) {
    if (!name.startsWith(CAPTURE_PREFIX)) continue;
    const recovery = join(dir, name);
    recovered = true;
    while (activeCaptures.has(recovery)) await activeCaptures.get(recovery);
    const recover = (async () => {
      const stats = await lstatOrNull(recovery);
      if (!stats?.isDirectory()) return;
      const entries = await readdir(recovery);
      if (
        entries.length > 1 ||
        entries.some((entry) => !isSafeRelativePath(entry))
      )
        throw new Error(`Invalid capture directory: ${recovery}`);
      if (entries.length === 1) {
        const entry = entries[0]!;
        const captured = join(recovery, entry);
        const path = posix.join(rel, entry);
        if (!(await preserveOpaque(root, path, captured))) {
          await preserveCaptured(root, path, captured);
          try {
            await publishCaptured(captured, join(root, path));
          } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
          }
          await unlink(captured);
        }
      }
      await rmdir(recovery);
    })();
    activeCaptures.set(recovery, recover);
    try {
      await recover;
    } finally {
      activeCaptures.delete(recovery);
    }
  }
  return recovered ? readdir(dir) : names;
}

/**
 * Capture the entry that rename actually removes, then verify that entry.
 * Publication and restoration must be no-clobber: an editor can save again
 * after capture. Recovery directories survive the stale-temp file cleanup.
 */
async function mutatePath(
  cache: HashCache,
  request: BoundRoot & { path: string; expected: Content | null },
  publish: ((root: string) => Promise<void>) | null,
  signal?: AbortSignal,
): Promise<ApplyResult> {
  signal?.throwIfAborted();
  const { path, expected } = request;
  const root = await requireRoot(request);
  const result = await guard(cache, root, path, expected, publish !== null);
  if (!result.ok) return result;
  const apply = async (): Promise<ApplyResult> => {
    try {
      await requireRoot(request);
      if ((await walkParents(root, path, false)) !== "ok") return blocked;
      signal?.throwIfAborted();
      await publish?.(root);
      await requireRoot(request);
      return ok;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return localChanged;
      throw error;
    }
  };
  await requireRoot(request);
  signal?.throwIfAborted();
  if (expected === null) return apply();
  if ((await walkParents(root, path, false)) !== "ok") return blocked;

  const abs = join(root, path);
  // Register ownership without yielding to a scan that could recover an empty directory.
  const recovery = mkdtempSync(join(dirname(abs), CAPTURE_PREFIX));
  const captured = join(recovery, posix.basename(path));
  let release!: () => void;
  activeCaptures.set(
    recovery,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let moved = false;
  let verified = false;
  let applied = false;
  try {
    try {
      await rename(abs, captured);
      moved = true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return localChanged;
      if (["EISDIR", "ENOTDIR"].includes(errorCode(error) ?? ""))
        return blocked;
      throw error;
    }
    await requireRoot(request);
    if ((await walkParents(root, path, false)) !== "ok") return blocked;
    const current = await currentContent(cache, root, relative(root, captured));
    verified = current !== "blocked" && sameContent(current, expected);
    if (!verified) return localChanged;
    const outcome = await apply();
    applied = outcome.ok;
    return outcome;
  } finally {
    try {
      if (await canonicalMatches(request.identity) &&
          (await walkParents(root, path, false)) === "ok") {
        if (moved && !applied && (await preserveOpaque(root, path, captured)))
          moved = false;
        if (moved && !applied) {
          // Preserve before restoration: another save may immediately replace it again.
          if (!verified) await preserveCaptured(root, path, captured);
          try {
            await publishCaptured(captured, abs);
          } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
            if (verified) await preserveCaptured(root, path, captured);
          }
        }
        if (moved) await unlink(captured);
        await rmdir(recovery);
      }
    } finally {
      activeCaptures.delete(recovery);
      release();
    }
  }
}

export interface ReadRequest extends BoundRoot {
  path: string;
  offset: number;
  length: number;
  size: number;
  mtimeMs: number;
}

/** Read one chunk, proving with fstat before and after that the file is the scanned one. */
export async function readChunk(
  request: ReadRequest,
): Promise<{ ok: true; data: string } | { ok: false; reason: "changed" }> {
  requireSafe(request.path);
  const root = await requireRoot(request);
  if ((await walkParents(root, request.path, false)) !== "ok")
    return { ok: false, reason: "changed" };
  await requireRoot(request);
  if ((await walkParents(root, request.path, false)) !== "ok")
    return { ok: false, reason: "changed" };
  let handle;
  try {
    handle = await open(
      join(root, request.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(errorCode(error) ?? ""))
      return { ok: false, reason: "changed" };
    throw error;
  }
  try {
    const before = await handle.stat();
    const matches = (stats: Stats) =>
      stats.isFile() &&
      stats.size === request.size &&
      stats.mtimeMs === request.mtimeMs;
    if (!matches(before)) return { ok: false, reason: "changed" };
    const buffer = Buffer.alloc(
      Math.min(request.length, Math.max(0, request.size - request.offset)),
    );
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        request.offset + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const after = await handle.stat();
    if (filled !== buffer.length || !matches(after) || !sameFile(before, after))
      return { ok: false, reason: "changed" };
    await requireRoot(request);
    return { ok: true, data: buffer.toString("base64") };
  } finally {
    await handle.close();
  }
}

function tempPath(root: string, path: string, tempId: string): string {
  return join(root, posix.dirname(path), `${TEMP_PREFIX}${tempId}`);
}

/** Append one chunk to the temporary file beside `path`; offset 0 starts it. */
export async function writeChunk(request: BoundRoot & {
  path: string;
  tempId: string;
  offset: number;
  data: string;
}): Promise<ApplyResult> {
  requireSafe(request.path);
  const root = await requireRoot(request);
  if ((await walkParents(root, request.path, true)) !== "ok") return blocked;
  await requireRoot(request);
  if ((await walkParents(root, request.path, false)) !== "ok") return blocked;
  const temp = tempPath(root, request.path, request.tempId);
  const flags =
    request.offset === 0
      ? constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_NOFOLLOW;
  const handle = await open(temp, flags, 0o600);
  try {
    if ((await handle.stat()).size !== request.offset)
      throw new Error("Chunk out of order");
    const data = Buffer.from(request.data, "base64");
    let written = 0;
    while (written < data.length) {
      const { bytesWritten } = await handle.write(
        data,
        written,
        data.length - written,
        request.offset + written,
      );
      if (bytesWritten === 0) throw new Error("Chunk write made no progress");
      written += bytesWritten;
    }
    await handle.sync();
    await requireRoot(request);
  } finally {
    await handle.close();
  }
  return ok;
}

/** Verify the assembled file, capture the target, and publish without overwriting a save. */
export async function commitFile(
  cache: HashCache,
  request: BoundRoot & {
    path: string;
    tempId: string;
    content: Extract<Content, { kind: "file" }>;
    expected: Content | null;
  },
  signal?: AbortSignal,
): Promise<ApplyResult> {
  signal?.throwIfAborted();
  const root = await requireRoot(request);
  if ((await walkParents(root, request.path, false)) !== "ok") return blocked;
  const temp = tempPath(root, request.path, request.tempId);
  try {
    const stats = await lstat(temp);
    if (
      !stats.isFile() ||
      stats.size !== request.content.size ||
      (await hashFile(temp)) !== request.content.hash
    )
      throw new Error("Transferred file failed verification");
    // Mirrored files are private to the owner on every machine; only the exec bit travels.
    await requireRoot(request);
    if ((await walkParents(root, request.path, false)) !== "ok") return blocked;
    await chmod(temp, request.content.exec ? 0o700 : 0o600);
    return await mutatePath(
      cache, request,
      (canonical) => link(temp, join(canonical, request.path)),
      signal,
    );
  } finally {
    if (await canonicalMatches(request.identity) &&
        (await walkParents(root, request.path, false)) === "ok")
      await unlink(temp).catch(() => {});
  }
}

export async function writeLink(
  cache: HashCache,
  request: BoundRoot & {
    path: string;
    target: string;
    expected: Content | null;
  },
  signal?: AbortSignal,
): Promise<ApplyResult> {
  requireSafe(request.path);
  if (!isSafeSymlinkTarget(request.path, request.target))
    throw new Error("Refusing a symlink that leaves the root");
  return mutatePath(
    cache, request,
    (canonical) => symlink(request.target, join(canonical, request.path)),
    signal,
  );
}

/** Delete a path that still holds `expected`, then prune emptied parent directories. */
export async function removePath(
  cache: HashCache,
  request: BoundRoot & { path: string; expected: Content },
  signal?: AbortSignal,
): Promise<ApplyResult> {
  const result = await mutatePath(cache, request, null, signal);
  if (!result.ok) return result;
  let dir = posix.dirname(request.path);
  while (dir !== ".") {
    try {
      const root = await requireRoot(request);
      await rmdir(join(root, dir));
    } catch {
      break;
    }
    dir = posix.dirname(dir);
  }
  await requireRoot(request);
  return ok;
}
