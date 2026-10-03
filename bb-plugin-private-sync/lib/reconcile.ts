import { randomBytes } from "node:crypto";
import type { ExperimentalHostClient } from "@get-bb/plugin-sdk";
import {
  CHUNK_BYTES,
  sameContent,
  type ApplyResult,
  type Content,
  type Conflict,
  type FolderConfig,
  type ScanEntry,
  hostContract,
  hostSignals,
} from "../contract";
import { conflictPath, isIgnored, isWithin } from "./paths";
import type { BlobWriter, Store } from "./store";

export type HostClient = Pick<
  ExperimentalHostClient<typeof hostContract, typeof hostSignals>,
  "call"
>;

/** First scan of a large root hashes every file; give it room. */
const SCAN_TIMEOUT_MS = 20 * 60_000;
const CHUNK_TIMEOUT_MS = 2 * 60_000;
/** Host calls in flight per pass. */
const PARALLEL_CALLS = 4;

type FileEntry = Extract<ScanEntry, { kind: "file" }>;
type FileContent = Extract<Content, { kind: "file" }>;

/** A node-level failure with a message safe to show (never a path). */
export class NodeError extends Error {}

export interface PassRequest {
  store: Store;
  host: HostClient;
  folder: FolderConfig;
  hostId: string;
  root: string;
  /** "all" scans the whole root, a list scans those paths, null only applies hub changes. */
  scope: "all" | readonly string[] | null;
  signal: AbortSignal;
  now: () => number;
  /** Transfer for this long, then yield at a chunk boundary. */
  sliceMs: number;
  /** Partial downloads owned by this node in the current configuration. */
  transfers: Map<string, DownloadTransfer>;
  /** One partial blob per missing hash, shared by every path with those bytes. */
  uploads: Map<string, UploadTransfer>;
}

export interface PassResult {
  /** Paths to look at again soon: busy files, files that changed mid-read, writes refused by a local edit. */
  retry: string[];
  /** Uploads awaiting another slice, without failure backoff. */
  deferred: string[];
  /** Paths that cannot be applied because a symlink or file sits in the way. */
  blocked: number;
  /** The slice ran out with transfers still pending; not a failure. */
  more: boolean;
  /** Folder version this node now matches, or null when something is outstanding. */
  acked: number | null;
}

function toContent(entry: ScanEntry | undefined): Content | null {
  if (entry === undefined || entry.kind === "busy") return null;
  if (entry.kind === "file")
    return {
      kind: "file",
      hash: entry.hash,
      size: entry.size,
      exec: entry.exec,
    };
  return { kind: "symlink", target: entry.target };
}

/**
 * Run at least one job with bounded concurrency, then heed `keepGoing`.
 * On error, stop taking jobs and rethrow after the rest settle.
 */
async function pool(
  jobs: (() => Promise<void>)[],
  keepGoing: () => boolean,
): Promise<number> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < jobs.length && (next === 0 || keepGoing())) {
      const job = jobs[next++]!;
      try {
        await job();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_CALLS, jobs.length) }, worker),
  );
  if (failed) throw failure;
  return next;
}

/** Group items of at most CHUNK_BYTES into batches of at most CHUNK_BYTES; larger items come back apart. */
function batch<T>(
  items: T[],
  size: (item: T) => number,
): { batches: T[][]; large: T[] } {
  const batches: T[][] = [];
  const large: T[] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = size(item);
    if (itemBytes > CHUNK_BYTES) {
      large.push(item);
      continue;
    }
    if (
      current.length > 0 &&
      (bytes + itemBytes > CHUNK_BYTES || current.length >= 4096)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);
  return { batches, large };
}

async function scanAll(
  request: PassRequest,
  paths: readonly string[] | undefined,
): Promise<{ entries: Map<string, ScanEntry>; empty: boolean }> {
  const { host, hostId, root, folder, signal } = request;
  const first = await host.call(
    "scan",
    {
      root,
      ignorePaths: folder.ignorePaths,
      ...(paths ? { paths: [...paths] } : {}),
    },
    { hostId, signal, timeoutMs: SCAN_TIMEOUT_MS },
  );
  if (!first.ok)
    throw new NodeError(
      first.reason === "root-missing"
        ? "The folder root is missing on this machine. Nothing was changed."
        : "The folder root contains the plugin's own data directory.",
    );
  const entries = [...first.entries];
  for (let page = 1; page < first.pages; page += 1) {
    const next = await host.call(
      "scanPage",
      { scanId: first.scanId, page },
      { hostId, signal },
    );
    entries.push(...next.entries);
  }
  return {
    entries: new Map(entries.map((entry) => [entry.path, entry])),
    empty: first.empty,
  };
}

/**
 * Copy node files into the hub blob store, skipping bytes the hub already
 * has. Incomplete hashes defer every dependent path; changed files are retried.
 */
async function uploadAll(
  request: PassRequest,
  entries: FileEntry[],
  sliceEnds: number,
): Promise<{ changed: Set<string>; deferred: Set<string> }> {
  const { store, host, hostId, root, signal, uploads, now } = request;
  const changed = new Set<string>();
  // One read per missing hash; every path sharing it depends on that read.
  const byHash = new Map<string, FileEntry>();
  const pathsOf = new Map<string, string[]>();
  for (const entry of entries) {
    const paths = pathsOf.get(entry.hash);
    if (paths) paths.push(entry.path);
    else if (!(await store.hasBlob(entry.hash))) {
      byHash.set(entry.hash, entry);
      pathsOf.set(entry.hash, [entry.path]);
    }
  }
  for (const [hash, transfer] of uploads) {
    const entry = byHash.get(hash);
    if (
      !entry ||
      entry.path !== transfer.entry.path ||
      entry.size !== transfer.entry.size ||
      entry.mtimeMs !== transfer.entry.mtimeMs
    ) {
      await transfer.writer.abort();
      uploads.delete(hash);
    }
  }
  const deferred = new Set([...pathsOf.values()].flat());
  /** The representative changed under the reader, so no path with its hash has a blob yet. */
  const failed = (entry: FileEntry) => {
    for (const path of pathsOf.get(entry.hash)!) {
      changed.add(path);
      deferred.delete(path);
    }
  };

  const range = (entry: FileEntry, offset: number) => ({
    path: entry.path,
    offset,
    length: Math.min(CHUNK_BYTES, entry.size - offset),
    size: entry.size,
    mtimeMs: entry.mtimeMs,
  });
  /** Stream one file into a blob, one chunk in memory at a time; null data means the file changed. */
  const saveBlob = async (
    entry: FileEntry,
    chunkAt: (offset: number) => Promise<string | null>,
  ) => {
    let transfer = uploads.get(entry.hash);
    if (!transfer) {
      transfer = { entry, writer: await store.blobWriter(), offset: 0 };
      uploads.set(entry.hash, transfer);
    }
    const { writer } = transfer;
    // Even an empty file must consume the host's identity check.
    do {
      const data = await chunkAt(transfer.offset);
      if (data === null) {
        await writer.abort();
        uploads.delete(entry.hash);
        failed(entry);
        return;
      }
      await writer.write(Buffer.from(data, "base64"));
      transfer.offset += Math.min(CHUNK_BYTES, entry.size - transfer.offset);
      if (
        transfer.offset < entry.size &&
        (signal.aborted || now() >= sliceEnds)
      )
        return;
    } while (transfer.offset < entry.size);
    if (!(await writer.finish(entry.hash, entry.size))) failed(entry);
    else for (const path of pathsOf.get(entry.hash)!) deferred.delete(path);
    uploads.delete(entry.hash);
  };
  const read = async (ranges: ReturnType<typeof range>[]) =>
    (
      await host.call(
        "read",
        { root, ranges },
        { hostId, signal, timeoutMs: CHUNK_TIMEOUT_MS },
      )
    ).results.map((result) => (result.ok ? result.data : null));

  const { batches, large } = batch([...byHash.values()], (entry) => entry.size);
  const jobs = batches.map((group) => async () => {
    const results = await read(group.map((entry) => range(entry, 0)));
    for (const [index, entry] of group.entries())
      await saveBlob(entry, async () => results[index]!);
  });
  for (const entry of large)
    jobs.push(() =>
      saveBlob(
        entry,
        async (offset) => (await read([range(entry, offset)]))[0]!,
      ),
    );
  signal.throwIfAborted();
  await pool(jobs, () => !signal.aborted && now() < sliceEnds);
  return { changed, deferred };
}

export interface UploadTransfer {
  entry: FileEntry;
  writer: BlobWriter;
  offset: number;
}

interface Download {
  path: string;
  content: Content | null;
  expected: Content | null;
}

export interface DownloadTransfer extends Download {
  content: FileContent;
  tempId: string;
  offset: number;
}

/**
 * One node's pass, run under the folder's lock. Local changes go up first,
 * judged against the node's acknowledged base; then hub changes the node
 * lacks come down, each write checked against what the node holds.
 */
export async function reconcileNode(request: PassRequest): Promise<PassResult> {
  return request.store.withBlobs(() => reconcile(request));
}

async function reconcile(request: PassRequest): Promise<PassResult> {
  const { store, host, folder, hostId, root, scope, signal, now } = request;
  signal.throwIfAborted();
  store.prepareNode(folder.id, hostId, root);
  const retry = new Set<string>();
  let deferred = new Set<string>();
  let blocked = 0;

  // Exclusions gate both directions, including hub entries stored before a path was excluded.
  const mirrored = (path: string) => !isIgnored(path, folder.ignorePaths);
  let local: Map<string, ScanEntry> | null = null;
  let inScope: (path: string) => boolean = () => false;
  const scan = await scanAll(
    request,
    scope === "all" ? undefined : (scope ?? []),
  );
  if (scope !== null) {
    local = scan.entries;
    inScope =
      scope === "all"
        ? () => true
        : (path) => scope.some((prefix) => isWithin(path, prefix));
  }
  const sliceEnds = now() + request.sliceMs;
  const base = store.bases(folder.id, hostId);
  const known = [...base.keys()].filter(mirrored);
  const current = store.head(folder.id);
  // An uncertain remove can empty the root legitimately only when all held paths are hub tombstones.
  if (scan.empty && known.some((path) => current.get(path)?.content !== null))
    throw new NodeError(
      "The folder root is empty here but held synced files before. Nothing was deleted.",
    );

  if (local) {
    const changes: {
      path: string;
      entry: ScanEntry | undefined;
      mine: Content | null;
      before: Content | null;
    }[] = [];
    for (const path of new Set([...local.keys(), ...known.filter(inScope)])) {
      const entry = local.get(path);
      if (entry?.kind === "busy") {
        retry.add(path);
        continue;
      }
      const mine = toContent(entry);
      const before = base.get(path) ?? null;
      if (!sameContent(mine, before))
        changes.push({ path, entry, mine, before });
    }
    store.assertTree(
      folder.id,
      changes.flatMap(({ path, mine, before }) =>
        mine !== null || sameContent(current.get(path)?.content ?? null, before)
          ? [{ path, content: mine }]
          : [],
      ),
    );
    // Clean removals must precede entries that reuse their paths as directories.
    changes.sort((a, b) => Number(a.mine !== null) - Number(b.mine !== null));
    const uploaded = await uploadAll(
      request,
      changes.flatMap(({ entry }) => (entry?.kind === "file" ? [entry] : [])),
      sliceEnds,
    );
    deferred = uploaded.deferred;
    signal.throwIfAborted();

    const head = store.head(folder.id);
    const taken = (path: string) => head.has(path) || local!.has(path);
    for (const { path, mine, before } of changes) {
      if (uploaded.changed.has(path)) {
        retry.add(path);
        continue;
      }
      if (deferred.has(path)) continue;
      const hub = head.get(path)?.content ?? null;
      const at = now();
      if (sameContent(mine, hub)) {
        // Both sides made the same change, deletes included.
        store.setBase(folder.id, hostId, path, mine);
      } else if (sameContent(hub, before)) {
        // The hub still holds what this node last saw: the node's change wins cleanly.
        store.transaction(() => {
          store.commit(folder.id, hostId, path, mine, at);
          store.setBase(folder.id, hostId, path, mine);
        });
      } else if (mine === null) {
        // Deleted here, edited elsewhere: keep the edit, the download below restores it.
        store.transaction(() => {
          store.setBase(folder.id, hostId, path, null);
          store.addConflict(folder.id, {
            path,
            conflictPath: null,
            hostId,
            kind: "delete-edit",
            detectedAt: at,
          });
        });
      } else {
        // Both sides changed: this node's version is preserved beside the hub's.
        let attempt = 0;
        let copy = conflictPath(path, hostId, new Date(at));
        while (taken(copy))
          copy = conflictPath(path, hostId, new Date(at), ++attempt);
        const kind: Conflict["kind"] =
          hub === null ? "edit-delete" : "edit-edit";
        store.transaction(() => {
          store.commit(folder.id, hostId, copy, mine, at);
          // The local version is preserved; rescans and sliced writes can now use it as their base.
          store.setBase(folder.id, hostId, path, mine);
          store.addConflict(folder.id, {
            path,
            conflictPath: copy,
            hostId,
            kind,
            detectedAt: at,
          });
        });
        head.set(copy, { content: mine, version: store.seq(folder.id) });
      }
    }
  }

  const version = store.seq(folder.id);
  const head = store.head(folder.id);
  const applied = store.bases(folder.id, hostId);
  const downloads: Download[] = [];
  for (const path of new Set([...head.keys(), ...applied.keys()])) {
    if (retry.has(path) || deferred.has(path) || !mirrored(path)) continue;
    const hub = head.get(path)?.content ?? null;
    const before = applied.get(path) ?? null;
    if (sameContent(hub, before)) continue;
    // The scan is the freshest view of the node; outside it the base stands in.
    const expected =
      local && inScope(path) ? toContent(local.get(path)) : before;
    if (hub === null && expected === null)
      store.setBase(folder.id, hostId, path, null);
    else downloads.push({ path, content: hub, expected });
  }
  // Newest hub changes first, so a live edit never waits behind a bulk download.
  const versionOf = (download: Download) =>
    head.get(download.path)?.version ?? 0;
  downloads.sort((x, y) => versionOf(y) - versionOf(x));

  const settle = (download: Download, result: ApplyResult) => {
    if (result.ok)
      store.setBase(folder.id, hostId, download.path, download.content);
    else if (result.reason === "local-changed") retry.add(download.path);
    else blocked += 1;
  };
  const write = async (items: WriteItem[]) =>
    (
      await host.call(
        "write",
        { root, items },
        { hostId, signal, timeoutMs: CHUNK_TIMEOUT_MS },
      )
    ).results;
  const files = downloads.filter(
    (download): download is Download & { content: FileContent } =>
      download.content?.kind === "file",
  );
  const { batches, large } = batch(files, (download) => download.content.size);
  const largePaths = new Set(large.map((download) => download.path));
  for (const path of request.transfers.keys())
    if (!largePaths.has(path)) request.transfers.delete(path);
  let partial = false;
  const jobFor = (download: Download, run: () => Promise<void>) => ({
    version: versionOf(download),
    run,
  });
  const jobs = batches.map((group) =>
    jobFor(group[0]!, async () => {
      const items = await Promise.all(
        group.map(async ({ path, content, expected }) => ({
          path,
          tempId: randomBytes(12).toString("hex"),
          offset: 0,
          data: (await store.readBlob(content.hash, 0, content.size)).toString(
            "base64",
          ),
          commit: { content, expected },
        })),
      );
      const results = await write(items);
      group.forEach((download, index) => settle(download, results[index]!));
    }),
  );
  for (const download of large)
    jobs.push(
      jobFor(download, async () => {
        const { path, content, expected } = download;
        let transfer = request.transfers.get(path);
        if (
          !transfer ||
          !sameContent(transfer.content, content) ||
          !sameContent(transfer.expected, expected)
        ) {
          transfer = {
            ...download,
            tempId: transfer?.tempId ?? randomBytes(12).toString("hex"),
            offset: 0,
          };
          request.transfers.set(path, transfer);
        }
        while (transfer.offset < content.size) {
          const { offset, tempId } = transfer;
          const length = Math.min(CHUNK_BYTES, content.size - offset);
          const data = (
            await store.readBlob(content.hash, offset, length)
          ).toString("base64");
          const last = offset + length >= content.size;
          const [result] = await write([
            {
              path,
              tempId,
              offset,
              data,
              commit: last ? { content, expected } : null,
            },
          ]);
          if (!result!.ok || last) {
            request.transfers.delete(path);
            return settle(download, result!);
          }
          transfer.offset += length;
          if (signal.aborted || now() >= sliceEnds) {
            partial = true;
            return;
          }
        }
      }),
    );
  for (const download of downloads) {
    const { path, content, expected } = download;
    if (content?.kind === "symlink")
      jobs.push(
        jobFor(download, async () =>
          settle(
            download,
            await host.call(
              "link",
              { root, path, target: content.target, expected },
              { hostId, signal },
            ),
          ),
        ),
      );
    else if (content === null && expected !== null)
      jobs.push(
        jobFor(download, async () =>
          settle(
            download,
            await host.call(
              "remove",
              { root, path, expected },
              { hostId, signal },
            ),
          ),
        ),
      );
  }
  signal.throwIfAborted();
  const started = await pool(
    jobs.sort((a, b) => b.version - a.version).map((job) => job.run),
    () => !signal.aborted && now() < sliceEnds,
  );
  signal.throwIfAborted();

  const more = deferred.size > 0 || partial || started < jobs.length;
  const clean = retry.size === 0 && blocked === 0 && !more;
  if (clean) store.setAcked(folder.id, hostId, version, now());
  return {
    retry: [...retry],
    deferred: [...deferred],
    blocked,
    more,
    acked: clean ? version : null,
  };
}

interface WriteItem {
  path: string;
  tempId: string;
  offset: number;
  data: string;
  commit: { content: FileContent; expected: Content | null } | null;
}
