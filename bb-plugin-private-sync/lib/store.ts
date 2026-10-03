import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import type { Conflict, Content } from "../contract";

/** History rows and their blobs are kept this long for recovery. */
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const TREE_CONFLICT =
  "File and directory versions conflict. Resolve the tree conflict before syncing.";

export const MIGRATIONS = [
  `CREATE TABLE folders (id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0, seeded INTEGER NOT NULL DEFAULT 0)`,
  // The hub's current view of every path; kind 'deleted' rows are tombstones.
  `CREATE TABLE head (folder TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT, size INTEGER, exec INTEGER, target TEXT, version INTEGER NOT NULL, host TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (folder, path))`,
  // What each node last acknowledged per path: the base its next change is judged against.
  `CREATE TABLE base (folder TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT, size INTEGER, exec INTEGER, target TEXT, PRIMARY KEY (folder, host, path))`,
  `CREATE TABLE nodes (folder TEXT NOT NULL, host TEXT NOT NULL, root TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, last_sync_at INTEGER, PRIMARY KEY (folder, host))`,
  `CREATE TABLE history (id INTEGER PRIMARY KEY, folder TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT, size INTEGER, exec INTEGER, target TEXT, version INTEGER NOT NULL, host TEXT NOT NULL, archived_at INTEGER NOT NULL)`,
  `CREATE INDEX history_archived ON history (archived_at)`,
  `CREATE TABLE conflicts (id INTEGER PRIMARY KEY, folder TEXT NOT NULL, path TEXT NOT NULL, conflict_path TEXT, host TEXT NOT NULL, kind TEXT NOT NULL, detected_at INTEGER NOT NULL, resolved_at INTEGER)`,
];

export interface HeadEntry {
  /** null is a tombstone. */
  content: Content | null;
  version: number;
}

interface ContentRow {
  kind: string;
  hash: string | null;
  size: number | null;
  exec: number | null;
  target: string | null;
}

function toContent(row: ContentRow): Content | null {
  if (row.kind === "file")
    return {
      kind: "file",
      hash: row.hash!,
      size: row.size ?? 0,
      exec: row.exec === 1,
    };
  if (row.kind === "symlink") return { kind: "symlink", target: row.target! };
  return null;
}

function columns(content: Content | null) {
  if (content === null)
    return {
      kind: "deleted",
      hash: null,
      size: null,
      exec: null,
      target: null,
    };
  if (content.kind === "file")
    return {
      kind: "file",
      hash: content.hash,
      size: content.size,
      exec: content.exec ? 1 : 0,
      target: null,
    };
  return {
    kind: "symlink",
    hash: null,
    size: null,
    exec: null,
    target: content.target,
  };
}

/** Streams one upload into a temporary blob, hashing as it goes. */
export class BlobWriter {
  private readonly hash = createHash("sha256");
  private size = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly temp: string,
    private readonly finalPath: (hash: string) => string,
  ) {}

  async write(data: Buffer): Promise<void> {
    await this.handle.writeFile(data);
    this.hash.update(data);
    this.size += data.length;
  }

  /** False when the bytes do not match what the scan promised. */
  async finish(expectedHash: string, expectedSize: number): Promise<boolean> {
    await this.handle.sync();
    await this.handle.close();
    const hash = this.hash.digest("hex");
    if (hash !== expectedHash || this.size !== expectedSize) {
      await unlink(this.temp).catch(() => {});
      return false;
    }
    const target = this.finalPath(hash);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.temp, target);
    return true;
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => {});
    await unlink(this.temp).catch(() => {});
  }
}

export class Store {
  private readonly blobDir: string;
  private blobUsers = 0;
  private pruning: Promise<number> | null = null;
  private blobsIdle: (() => void) | null = null;

  constructor(private readonly db: Database.Database) {
    const dataDir = dirname(db.name);
    chmodSync(dataDir, 0o700);
    chmodSync(db.name, 0o600);
    // Blobs live beside data.db, inside the server's plugin data directory.
    this.blobDir = join(dataDir, "blobs");
    mkdirSync(join(this.blobDir, "tmp"), { recursive: true });
  }

  private ensureFolder(folder: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO folders (id) VALUES (?)`)
      .run(folder);
  }

  seq(folder: string): number {
    const row = this.db
      .prepare(`SELECT seq FROM folders WHERE id = ?`)
      .get(folder) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  isSeeded(folder: string): boolean {
    const row = this.db
      .prepare(`SELECT seeded FROM folders WHERE id = ?`)
      .get(folder) as { seeded: number } | undefined;
    return row?.seeded === 1;
  }

  markSeeded(folder: string): void {
    this.ensureFolder(folder);
    this.db.prepare(`UPDATE folders SET seeded = 1 WHERE id = ?`).run(folder);
  }

  head(folder: string): Map<string, HeadEntry> {
    const rows = this.db
      .prepare(
        `SELECT path, kind, hash, size, exec, target, version FROM head WHERE folder = ?`,
      )
      .all(folder) as (ContentRow & { path: string; version: number })[];
    return new Map(
      rows.map((row) => [
        row.path,
        { content: toContent(row), version: row.version },
      ]),
    );
  }

  bases(folder: string, host: string): Map<string, Content> {
    const rows = this.db
      .prepare(
        `SELECT path, kind, hash, size, exec, target FROM base WHERE folder = ? AND host = ?`,
      )
      .all(folder, host) as (ContentRow & { path: string })[];
    return new Map(rows.map((row) => [row.path, toContent(row)!]));
  }

  /**
   * Register a node's root. A node that now points at a different directory
   * starts over as a fresh node, so the old bases never read as deletions.
   */
  prepareNode(folder: string, host: string, root: string): void {
    const row = this.db
      .prepare(`SELECT root FROM nodes WHERE folder = ? AND host = ?`)
      .get(folder, host) as { root: string } | undefined;
    if (row?.root === root) return;
    this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM base WHERE folder = ? AND host = ?`)
        .run(folder, host);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO nodes (folder, host, root, acked, last_sync_at) VALUES (?, ?, ?, 0, NULL)`,
        )
        .run(folder, host, root);
    })();
  }

  node(
    folder: string,
    host: string,
  ): { acked: number; lastSyncAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT acked, last_sync_at FROM nodes WHERE folder = ? AND host = ?`,
      )
      .get(folder, host) as
      { acked: number; last_sync_at: number | null } | undefined;
    return { acked: row?.acked ?? 0, lastSyncAt: row?.last_sync_at ?? null };
  }

  setAcked(folder: string, host: string, version: number, at: number): void {
    this.db
      .prepare(
        `UPDATE nodes SET acked = ?, last_sync_at = ? WHERE folder = ? AND host = ?`,
      )
      .run(version, at, folder, host);
  }

  setBase(
    folder: string,
    host: string,
    path: string,
    content: Content | null,
  ): void {
    if (content === null) {
      this.db
        .prepare(`DELETE FROM base WHERE folder = ? AND host = ? AND path = ?`)
        .run(folder, host, path);
      return;
    }
    const c = columns(content);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO base (folder, host, path, kind, hash, size, exec, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(folder, host, path, c.kind, c.hash, c.size, c.exec, c.target);
  }

  transaction(run: () => void): void {
    this.db.transaction(run)();
  }

  /** A head contains files and links; none can also be another entry's directory. */
  assertTree(
    folder: string,
    changes: { path: string; content: Content | null }[],
  ): void {
    if (changes.length === 1) {
      const { path, content } = changes[0]!;
      if (content === null) return;
      const ancestor = this.db.prepare(
        `SELECT 1 FROM head WHERE folder = ? AND path = ? AND kind != 'deleted'`,
      );
      for (
        let end = path.indexOf("/");
        end !== -1;
        end = path.indexOf("/", end + 1)
      )
        if (ancestor.get(folder, path.slice(0, end)))
          throw new Error(TREE_CONFLICT);
      if (
        this.db
          .prepare(
            `SELECT 1 FROM head WHERE folder = ? AND path >= ? AND path < ? AND kind != 'deleted' LIMIT 1`,
          )
          .get(folder, `${path}/`, `${path}0`)
      )
        throw new Error(TREE_CONFLICT);
      return;
    }
    const paths = new Set(
      [...this.head(folder)]
        .filter(([, entry]) => entry.content !== null)
        .map(([path]) => path),
    );
    for (const { path, content } of changes) {
      if (content === null) paths.delete(path);
      else paths.add(path);
    }
    for (const path of paths)
      for (
        let end = path.indexOf("/");
        end !== -1;
        end = path.indexOf("/", end + 1)
      )
        if (paths.has(path.slice(0, end))) throw new Error(TREE_CONFLICT);
  }

  /** Make `content` the head of `path` (null deletes it) and archive what it replaces. */
  commit(
    folder: string,
    host: string,
    path: string,
    content: Content | null,
    at: number,
  ): void {
    this.db.transaction(() => {
      if (content !== null) this.assertTree(folder, [{ path, content }]);
      this.ensureFolder(folder);
      const previous = this.db
        .prepare(
          `SELECT kind, hash, size, exec, target, version, host FROM head WHERE folder = ? AND path = ?`,
        )
        .get(folder, path) as
        (ContentRow & { version: number; host: string }) | undefined;
      if (
        content === null &&
        (previous === undefined || previous.kind === "deleted")
      )
        return;
      if (previous && previous.kind !== "deleted")
        this.db
          .prepare(
            `INSERT INTO history (folder, path, kind, hash, size, exec, target, version, host, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            folder,
            path,
            previous.kind,
            previous.hash,
            previous.size,
            previous.exec,
            previous.target,
            previous.version,
            previous.host,
            at,
          );
      this.db
        .prepare(`UPDATE folders SET seq = seq + 1 WHERE id = ?`)
        .run(folder);
      const version = this.seq(folder);
      const c = columns(content);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO head (folder, path, kind, hash, size, exec, target, version, host, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          folder,
          path,
          c.kind,
          c.hash,
          c.size,
          c.exec,
          c.target,
          version,
          host,
          at,
        );
      // Deletion settles the copy, or the restored original when there is no copy.
      if (content === null)
        this.db
          .prepare(
            `UPDATE conflicts SET resolved_at = ? WHERE folder = ? AND (conflict_path = ? OR (conflict_path IS NULL AND path = ?)) AND resolved_at IS NULL`,
          )
          .run(at, folder, path, path);
    })();
  }

  addConflict(folder: string, conflict: Omit<Conflict, "id">): void {
    this.db
      .prepare(
        `INSERT INTO conflicts (folder, path, conflict_path, host, kind, detected_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        folder,
        conflict.path,
        conflict.conflictPath,
        conflict.hostId,
        conflict.kind,
        conflict.detectedAt,
      );
  }

  /** Acknowledgment changes only metadata; repeated and unknown IDs are harmless. */
  resolveConflict(folder: string, id: number, at: number): void {
    this.db.prepare(
      `UPDATE conflicts SET resolved_at = ? WHERE folder = ? AND id = ? AND resolved_at IS NULL`,
    ).run(at, folder, id);
  }

  openConflicts(
    folder: string,
    limit: number,
  ): { conflicts: Conflict[]; total: number; byHost: Map<string, number> } {
    const conflicts = (
      this.db
        .prepare(
          `SELECT id, path, conflict_path, host, kind, detected_at FROM conflicts WHERE folder = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT ?`,
        )
        .all(folder, limit) as {
        id: number;
        path: string;
        conflict_path: string | null;
        host: string;
        kind: Conflict["kind"];
        detected_at: number;
      }[]
    ).map((row) => ({
      id: row.id,
      path: row.path,
      conflictPath: row.conflict_path,
      hostId: row.host,
      kind: row.kind,
      detectedAt: row.detected_at,
    }));
    const counts = this.db
      .prepare(
        `SELECT host, COUNT(*) AS n FROM conflicts WHERE folder = ? AND resolved_at IS NULL GROUP BY host`,
      )
      .all(folder) as { host: string; n: number }[];
    const byHost = new Map(counts.map((row) => [row.host, row.n]));
    return {
      conflicts,
      total: counts.reduce((sum, row) => sum + row.n, 0),
      byHost,
    };
  }

  // -------------------------------------------------------------------------
  // Blobs

  private blobPath(hash: string): string {
    return join(this.blobDir, hash.slice(0, 2), hash);
  }

  /** Protect deduplication through head commit; maintenance never unlinks a blob in use. */
  async withBlobs<T>(run: () => Promise<T>): Promise<T> {
    while (this.pruning) await this.pruning;
    this.blobUsers += 1;
    try {
      return await run();
    } finally {
      this.blobUsers -= 1;
      if (this.blobUsers === 0) {
        this.blobsIdle?.();
        this.blobsIdle = null;
      }
    }
  }

  async hasBlob(hash: string): Promise<boolean> {
    return stat(this.blobPath(hash)).then(
      (stats) => stats.isFile(),
      () => false,
    );
  }

  async blobWriter(): Promise<BlobWriter> {
    const temp = join(this.blobDir, "tmp", randomBytes(12).toString("hex"));
    return new BlobWriter(await open(temp, "wx", 0o600), temp, (hash) =>
      this.blobPath(hash),
    );
  }

  async readBlob(
    hash: string,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    const handle = await open(this.blobPath(hash), "r");
    try {
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          length - filled,
          offset + filled,
        );
        if (bytesRead === 0)
          throw new Error("Hub blob is shorter than its record");
        filled += bytesRead;
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }

  /** Drop expired history, then every blob no head or history row still needs. */
  async prune(now: number): Promise<number> {
    if (this.pruning) return this.pruning;
    const idle =
      this.blobUsers > 0
        ? new Promise<void>((resolve) => {
            this.blobsIdle = resolve;
          })
        : Promise.resolve();
    this.pruning = idle.then(() => this.pruneBlobs(now));
    try {
      return await this.pruning;
    } finally {
      this.pruning = null;
    }
  }

  private async pruneBlobs(now: number): Promise<number> {
    this.db
      .prepare(`DELETE FROM history WHERE archived_at < ?`)
      .run(now - HISTORY_RETENTION_MS);
    const live = new Set(
      (
        this.db
          .prepare(
            `SELECT hash FROM head WHERE kind = 'file' UNION SELECT hash FROM history WHERE kind = 'file'`,
          )
          .all() as { hash: string }[]
      ).map((row) => row.hash),
    );
    let removed = 0;
    for (const prefix of await readdir(this.blobDir)) {
      if (prefix === "tmp") continue;
      for (const name of await readdir(join(this.blobDir, prefix))) {
        const path = join(this.blobDir, prefix, name);
        // A fresh blob may belong to an upload that has not committed yet.
        if (
          live.has(name) ||
          now - (await stat(path)).mtimeMs < 24 * 60 * 60_000
        )
          continue;
        await unlink(path);
        removed += 1;
      }
    }
    for (const name of await readdir(join(this.blobDir, "tmp"))) {
      const path = join(this.blobDir, "tmp", name);
      if (now - (await stat(path)).mtimeMs > 24 * 60 * 60_000)
        await unlink(path).catch(() => {});
    }
    return removed;
  }
}
