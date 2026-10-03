import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals, type ScanEntry } from "./contract";
import {
  HashCache,
  commitFile,
  readChunk,
  removePath,
  scanRoot,
  writeChunk,
  writeLink,
} from "./lib/host-fs";
import { isIgnored, isSafeRelativePath } from "./lib/paths";

type Context = ExperimentalHostRpcContext<typeof hostSignals>;

/** Bytes of JSON per scan page, far below the 8 MiB result cap. */
const PAGE_BYTES = 2 * 1024 * 1024;
const MAX_HELD_SCANS = 4;
const MAX_SIGNAL_PATHS = 512;

function paginate(entries: ScanEntry[]): ScanEntry[][] {
  const pages: ScanEntry[][] = [[]];
  let bytes = 0;
  for (const entry of entries) {
    const size = JSON.stringify(entry).length + 1;
    if (bytes + size > PAGE_BYTES && pages.at(-1)!.length > 0) {
      pages.push([]);
      bytes = 0;
    }
    pages.at(-1)!.push(entry);
    bytes += size;
  }
  return pages;
}

interface Watch {
  key: string;
  subscription: ExperimentalHostWatchSubscription;
  deactivate(): void;
}

/** Watcher paths may arrive absolute or root-relative; anything unexpected forces a rescan. */
function toRelative(root: string, path: string): string | null {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  return isSafeRelativePath(rel) ? rel : null;
}

/** One worker's entry. Tests build one per simulated machine. */
export function createHostEntry() {
  const caches = new Map<string, HashCache>();
  const cacheFor = (context: Context, root: string): HashCache => {
    let cache = caches.get(root);
    if (!cache) {
      // The file name is a digest so the host data dir never spells out a root.
      const key = createHash("sha256").update(root).digest("hex").slice(0, 32);
      cache = new HashCache(
        join(context.experimental_paths.dataDir, "hash-cache", `${key}.json`),
      );
      caches.set(root, cache);
    }
    return cache;
  };
  /** Finished scans waiting for scanPage, oldest first. */
  const scans = new Map<string, ScanEntry[][]>();
  const watches = new Map<string, Watch>();
  let watchQueue = Promise.resolve();
  let disposed = false;

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      scan: async ({ root, ignorePaths, paths }, context) => {
        const outcome = await scanRoot(cacheFor(context, root), {
          root,
          ignorePaths,
          paths,
          ownDirs: [
            context.experimental_paths.dataDir,
            context.experimental_paths.tempDir,
          ],
        });
        if (!outcome.ok) return outcome;
        const pages = paginate(outcome.entries);
        const scanId = randomUUID();
        if (pages.length > 1) {
          scans.set(scanId, pages);
          while (scans.size > MAX_HELD_SCANS)
            scans.delete(scans.keys().next().value!);
        }
        return {
          ok: true as const,
          scanId,
          pages: pages.length,
          entries: pages[0]!,
          skipped: outcome.skipped,
          empty: outcome.empty,
        };
      },
      scanPage: ({ scanId, page }) => {
        const pages = scans.get(scanId);
        if (!pages || page >= pages.length)
          throw new Error("Scan expired; scan again");
        if (page === pages.length - 1) scans.delete(scanId);
        return { entries: pages[page]! };
      },
      read: async ({ root, ranges }) => {
        const results = [];
        for (const range of ranges)
          results.push(await readChunk({ root, ...range }));
        return { results };
      },
      write: async ({ root, items }, context) => {
        const results = [];
        for (const { commit, ...chunk } of items) {
          const written = await writeChunk({ root, ...chunk });
          results.push(
            written.ok && commit
              ? await commitFile(cacheFor(context, root), {
                  root,
                  ...chunk,
                  ...commit,
                })
              : written,
          );
        }
        return { results };
      },
      link: (request, context) =>
        writeLink(cacheFor(context, request.root), request),
      remove: (request, context) =>
        removePath(cacheFor(context, request.root), request),
      watch: ({ folders }, context) => {
        const update = watchQueue.then(async () => {
          if (disposed || context.signal.aborted)
            return { watching: watches.size };
          const wanted = new Map(
            folders.map((folder) => [folder.folderId, folder]),
          );
          for (const [folderId, watch] of watches) {
            const folder = wanted.get(folderId);
            if (!folder || watch.key !== JSON.stringify(folder)) {
              watch.deactivate();
              watches.delete(folderId);
              await watch.subscription.dispose();
            }
          }
          for (const folder of folders) {
            if (disposed || context.signal.aborted) break;
            if (watches.has(folder.folderId)) continue;
            let active = true;
            const emit = (paths: string[] | null) => {
              if (!active || disposed || context.lifecycle.signal.aborted)
                return;
              return context
                .experimental_emitSignal("changed", {
                  folderId: folder.folderId,
                  paths,
                })
                .catch(() => {});
            };
            try {
              const subscription = await context.experimental_watch(
                { rootPath: folder.root, debounceMs: 300, maxWaitMs: 2000 },
                async (event) => {
                  if (event.kind !== "changed") return emit(null);
                  const paths = new Set<string>();
                  for (const change of event.changes) {
                    const rel = toRelative(folder.root, change.path);
                    if (rel === null) return emit(null);
                    if (!isIgnored(rel, folder.ignorePaths)) paths.add(rel);
                  }
                  if (paths.size === 0) return;
                  return emit(
                    paths.size > MAX_SIGNAL_PATHS ? null : [...paths],
                  );
                },
              );
              if (disposed || context.signal.aborted) {
                active = false;
                await subscription.dispose();
                break;
              }
              watches.set(folder.folderId, {
                key: JSON.stringify(folder),
                subscription,
                deactivate: () => {
                  active = false;
                },
              });
            } catch {
              // A missing root cannot be watched; the next full pass reports it and retries.
            }
          }
          return { watching: watches.size };
        });
        watchQueue = update.then(
          () => {},
          () => {},
        );
        return update;
      },
    },
    dispose: async () => {
      disposed = true;
      await watchQueue;
      await Promise.all(
        [...watches.values()].map((watch) => {
          watch.deactivate();
          return watch.subscription.dispose();
        }),
      );
      watches.clear();
    },
  });
}

export default createHostEntry();
