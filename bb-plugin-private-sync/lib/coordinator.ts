import type {
  FolderConfig,
  FolderStatus,
  NodePhase,
  NodeStatus,
  ResolvedPath,
  SyncStatus,
} from "../contract";
import { isWithin } from "./paths";
import {
  NodeError,
  reconcileNode,
  type DownloadTransfer,
  type HostClient,
  type UploadTransfer,
} from "./reconcile";
import type { Store } from "./store";

/** What other server modules (the machine-switch helper) may rely on. */
export interface SyncCoordinator {
  /** The folders in the active configuration, whether or not sync is running. */
  getConfig(): FolderConfig[];
  status(): SyncStatus;
  /**
   * Barrier: every named node (default all) finishes a full pass that started
   * after this call and matches the head version. Rejects when a named node is
   * offline, a pass fails, the configuration changes, or the timeout passes.
   * Concurrent calls are independent.
   */
  sync(
    folderId: string,
    hostIds?: string[],
    timeoutMs?: number,
  ): Promise<FolderStatus>;
  /** The configured folder holding an absolute path on a host, or null. */
  resolvePath(hostId: string, path: string): ResolvedPath;
}

export interface DesiredState {
  enabled: boolean;
  paused: boolean;
  folders: FolderConfig[];
  configError: string | null;
}

export interface Timings {
  /** How often host connectivity is polled. */
  pollMs: number;
  /** Safety-net full scan of every node; host signals are lossy. */
  fullPassMs: number;
  /** First retry delay; doubles per consecutive failure. */
  retryMs: number;
  maxBackoffMs: number;
  pruneMs: number;
  /** How long one pass transfers before yielding at a chunk boundary. */
  sliceMs: number;
}

const DEFAULT_TIMINGS: Timings = {
  pollMs: 15_000,
  fullPassMs: 10 * 60_000,
  retryMs: 2_000,
  maxBackoffMs: 5 * 60_000,
  pruneMs: 24 * 60 * 60_000,
  sliceMs: 5_000,
};
const DEFAULT_BARRIER_MS = 10 * 60_000;
const MAX_PENDING_PATHS = 512;
const STATUS_CONFLICTS = 50;

export interface CoordinatorOptions {
  store: Store;
  host: HostClient;
  /** Connected hosts, as BB reports them. */
  listHosts(signal: AbortSignal): Promise<{ id: string; status: string }[]>;
  /** Server log line; messages carry no paths or file contents. */
  log(message: string): void;
  onStatusChange(): void;
  now?: () => number;
  timings?: Partial<Timings>;
}

type Pending = "all" | Set<string>;

interface NodeRuntime {
  hostId: string;
  root: string;
  /** What must be rescanned on the next pass; null applies hub changes only. */
  pending: Pending | null;
  passing: boolean;
  transfers: Map<string, DownloadTransfer>;
  uploads: Map<string, UploadTransfer>;
  error: string | null;
  failures: number;
  retryAt: number;
  /** Tick when the latest full pass started. */
  fullStartedAt: number;
  /** Start tick of the full pass this node has been clean since; 0 before the first. */
  syncedSince: number;
  /** Start tick of the latest failed pass. */
  failedAt: number;
  /** Start tick of the latest pass; the lowest goes next. */
  lastPassAt: number;
}

function merge(
  pending: Pending | null,
  next: "all" | readonly string[],
): Pending {
  if (pending === "all" || next === "all") return "all";
  const merged = new Set(pending ?? []);
  for (const path of next) merged.add(path);
  return merged.size > MAX_PENDING_PATHS ? "all" : merged;
}

/** Host error text can name private files; status and logs keep everything but the paths. */
function safeMessage(error: unknown): string {
  if (error instanceof NodeError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(['"]?)\/[^\s'"]*\1/g, "<path>");
}

function sleep(
  ms: number,
  signal: AbortSignal,
  wake?: Promise<void>,
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    void wake?.then(done);
  });
}

export class Coordinator implements SyncCoordinator {
  private state: DesiredState = {
    enabled: false,
    paused: false,
    folders: [],
    configError: null,
  };
  private runners = new Map<string, FolderRunner>();
  private generation = new AbortController();
  private readonly online = new Set<string>();
  private readonly watched = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private clock = 0;
  private markPolled!: () => void;
  /** Settles after the first connectivity poll, so early barriers do not see every host as offline. */
  private readonly polled = new Promise<void>(
    (resolve) => (this.markPolled = resolve),
  );
  readonly timings: Timings;
  readonly now: () => number;

  constructor(readonly options: CoordinatorOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.now = options.now ?? Date.now;
  }

  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  isOnline(hostId: string): boolean {
    return this.online.has(hostId);
  }

  changed(): void {
    for (const listener of [...this.listeners]) listener();
    this.options.onStatusChange();
  }

  /** Replace the running configuration. Every in-flight pass and barrier of the old one is cancelled. */
  apply(state: DesiredState): void {
    // An unchanged state keeps the running generation, so its barriers survive.
    if (
      !this.generation.signal.aborted &&
      JSON.stringify(state) === JSON.stringify(this.state)
    )
      return;
    this.generation.abort();
    this.generation = new AbortController();
    this.state = state;
    this.runners = new Map();
    if (state.enabled && !state.paused && state.configError === null)
      for (const folder of state.folders) {
        const runner = new FolderRunner(this, folder, this.generation.signal);
        this.runners.set(folder.id, runner);
        void runner
          .loop()
          .catch((error: unknown) =>
            this.options.log(
              `folder ${folder.id} stopped: ${safeMessage(error)}`,
            ),
          );
      }
    for (const hostId of this.watched)
      if (!this.hostsInUse().has(hostId)) void this.ensureWatches(hostId);
    this.changed();
  }

  private hostsInUse(): Set<string> {
    return new Set(
      [...this.runners.values()].flatMap((runner) => [...runner.nodes.keys()]),
    );
  }

  /** Keep a host's native watches equal to the running folders it belongs to. */
  async ensureWatches(hostId: string): Promise<void> {
    const folders = [...this.runners.values()].flatMap((runner) => {
      const node = runner.nodes.get(hostId);
      return node
        ? [
            {
              folderId: runner.folder.id,
              root: node.root,
              ignorePaths: runner.folder.ignorePaths,
            },
          ]
        : [];
    });
    if (!this.isOnline(hostId)) return;
    try {
      await this.options.host.call(
        "watch",
        { folders },
        { hostId, signal: this.generation.signal },
      );
      if (folders.length > 0) this.watched.add(hostId);
      else this.watched.delete(hostId);
    } catch (error) {
      if (!this.generation.signal.aborted)
        this.options.log(`watch on ${hostId} failed: ${safeMessage(error)}`);
    }
  }

  onSignal(
    hostId: string,
    folderId: string,
    paths: readonly string[] | null,
  ): void {
    this.runners.get(folderId)?.mark(hostId, paths ?? "all", true);
  }

  /** A crashed worker lost its watches and anything in flight. */
  onWorkerExit(hostId: string): void {
    for (const runner of this.runners.values())
      runner.mark(hostId, "all", true);
  }

  /** Poll connectivity, schedule safety scans and pruning until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    let lastFull = this.now();
    let lastPrune = 0;
    let pruning: Promise<void> | null = null;
    while (!signal.aborted) {
      try {
        const hosts = await this.options.listHosts(signal);
        const connected = new Set(
          hosts
            .filter((host) => host.status === "connected")
            .map((host) => host.id),
        );
        let moved = false;
        for (const hostId of connected)
          if (!this.online.has(hostId)) {
            this.online.add(hostId);
            moved = true;
            for (const runner of this.runners.values())
              runner.mark(hostId, "all", false);
          }
        for (const hostId of [...this.online])
          if (!connected.has(hostId)) {
            this.online.delete(hostId);
            this.watched.delete(hostId);
            moved = true;
          }
        if (moved) this.changed();
      } catch (error) {
        if (!signal.aborted)
          this.options.log(`host list failed: ${safeMessage(error)}`);
      }
      this.markPolled();
      const now = this.now();
      if (now - lastFull >= this.timings.fullPassMs) {
        lastFull = now;
        for (const runner of this.runners.values())
          for (const hostId of runner.nodes.keys())
            runner.mark(hostId, "all", false);
      }
      if (pruning === null && now - lastPrune >= this.timings.pruneMs) {
        lastPrune = now;
        pruning = this.options.store
          .prune(now)
          .then(() => {})
          .catch((error: unknown) =>
            this.options.log(`prune failed: ${safeMessage(error)}`),
          )
          .finally(() => {
            pruning = null;
          });
      }
      await sleep(this.timings.pollMs, signal);
    }
    this.generation.abort();
    await pruning;
  }

  getConfig(): FolderConfig[] {
    return this.state.folders;
  }

  status(): SyncStatus {
    return {
      enabled: this.state.enabled,
      paused: this.state.paused,
      configError: this.state.configError,
      folders:
        this.state.configError === null
          ? this.state.folders.map((folder) => this.folderStatus(folder))
          : [],
    };
  }

  private folderStatus(folder: FolderConfig): FolderStatus {
    const { store } = this.options;
    const runner = this.runners.get(folder.id);
    const headVersion = store.seq(folder.id);
    const seeded = store.isSeeded(folder.id);
    const open = store.openConflicts(folder.id, STATUS_CONFLICTS);
    const nodes = folder.nodes.map((node): NodeStatus => {
      const runtime = runner?.nodes.get(node.hostId);
      const saved = store.node(folder.id, node.hostId);
      const conflicts = open.byHost.get(node.hostId) ?? 0;
      const acked = saved.acked;
      let phase: NodePhase;
      if (!this.state.enabled) phase = "disabled";
      else if (this.state.paused) phase = "paused";
      else if (!runtime) phase = "disabled";
      else if (!this.isOnline(node.hostId)) phase = "offline";
      else if (runtime.passing) phase = "syncing";
      else if (runtime.error !== null) phase = "error";
      else if (!seeded && node.hostId !== folder.primaryHostId)
        phase = "waiting-for-primary";
      else if (
        runtime.pending !== null ||
        runtime.syncedSince === 0 ||
        acked < headVersion
      )
        phase = "pending";
      else phase = "ready";
      return {
        hostId: node.hostId,
        path: node.path,
        phase,
        ready: phase === "ready",
        ackedVersion: acked,
        lag: Math.max(0, headVersion - acked),
        conflicts,
        error: runtime?.error ?? null,
        lastSyncAt: saved.lastSyncAt,
      };
    });
    return {
      id: folder.id,
      label: folder.label,
      primaryHostId: folder.primaryHostId,
      ignorePaths: folder.ignorePaths,
      headVersion,
      conflicts: open.conflicts,
      openConflicts: open.total,
      nodes,
    };
  }

  async sync(
    folderId: string,
    hostIds?: string[],
    timeoutMs = DEFAULT_BARRIER_MS,
  ): Promise<FolderStatus> {
    return new Promise<FolderStatus>((resolve, reject) => {
      let settled = false;
      let check = () => {};
      const finish = (error: Error | null, runner?: FolderRunner) => {
        if (settled) return;
        settled = true;
        this.listeners.delete(check);
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(this.folderStatus(runner!.folder));
      };
      const timer = setTimeout(
        () => finish(new Error("Timed out waiting for sync")),
        timeoutMs,
      );
      const signal = this.generation.signal;
      const begin = async () => {
        await this.polled;
        if (settled) return;
        if (signal.aborted)
          return finish(new Error("The sync configuration changed"));
        const runner = this.runners.get(folderId);
        if (!runner) {
          const known = this.state.folders.some(
            (folder) => folder.id === folderId,
          );
          if (!known) throw new Error(`Unknown folder ${folderId}`);
          throw new Error(
            this.state.paused ? "Sync is paused" : "Sync is not running",
          );
        }
        const targets =
          hostIds && hostIds.length > 0
            ? [...new Set(hostIds)]
            : [...runner.nodes.keys()];
        for (const hostId of targets) {
          if (!runner.nodes.has(hostId))
            throw new Error(`Folder ${folderId} has no node on ${hostId}`);
          if (!this.isOnline(hostId))
            throw new Error(`Machine ${hostId} is offline`);
        }
        const requestedAt = this.tick();
        check = () => {
          if (signal.aborted)
            return finish(new Error("The sync configuration changed"));
          const { store } = this.options;
          if (
            !store.isSeeded(folderId) &&
            !this.isOnline(runner.folder.primaryHostId)
          )
            return finish(
              new Error(
                "The folder has not been seeded yet and its primary machine is offline",
              ),
            );
          const seq = store.seq(folderId);
          let pending = false;
          for (const hostId of targets) {
            const node = runner.nodes.get(hostId)!;
            if (!this.isOnline(hostId))
              return finish(new Error(`Machine ${hostId} went offline`));
            if (node.failedAt > requestedAt)
              return finish(
                new Error(`Machine ${hostId}: ${node.error ?? "sync failed"}`),
              );
            const done =
              node.syncedSince > requestedAt &&
              !node.passing &&
              node.pending === null &&
              store.node(folderId, hostId).acked >= seq;
            if (!done) pending = true;
          }
          if (!pending) finish(null, runner);
        };
        for (const hostId of targets) runner.mark(hostId, "all", true);
        this.listeners.add(check);
        check();
      };
      void begin().catch((error: Error) => finish(error));
    });
  }

  resolvePath(hostId: string, path: string): ResolvedPath {
    for (const folder of this.state.folders) {
      const node = folder.nodes.find(
        (candidate) => candidate.hostId === hostId,
      );
      if (node && isWithin(path, node.path))
        return {
          folderId: folder.id,
          root: node.path,
          relativePath:
            path === node.path ? "" : path.slice(node.path.length + 1),
        };
    }
    return null;
  }
}

/** Serializes every pass of one folder; nodes take turns, the primary first. */
class FolderRunner {
  readonly nodes = new Map<string, NodeRuntime>();
  private wakeUp: (() => void) | null = null;

  constructor(
    private readonly coordinator: Coordinator,
    readonly folder: FolderConfig,
    private readonly signal: AbortSignal,
  ) {
    for (const node of folder.nodes)
      this.nodes.set(node.hostId, {
        hostId: node.hostId,
        root: node.path,
        pending: "all",
        passing: false,
        transfers: new Map(),
        uploads: new Map(),
        error: null,
        failures: 0,
        retryAt: 0,
        fullStartedAt: 0,
        syncedSince: 0,
        failedAt: 0,
        lastPassAt: 0,
      });
  }

  /** Queue a rescan. `urgent` skips most of a failure backoff because something new happened. */
  mark(
    hostId: string,
    paths: "all" | readonly string[],
    urgent: boolean,
  ): void {
    const node = this.nodes.get(hostId);
    if (!node) return;
    node.pending = merge(node.pending, paths);
    if (urgent)
      node.retryAt = Math.min(
        node.retryAt,
        this.coordinator.now() + this.coordinator.timings.retryMs,
      );
    this.wakeUp?.();
  }

  private due(node: NodeRuntime, seeded: boolean, seq: number): boolean {
    if (!this.coordinator.isOnline(node.hostId)) return false;
    if (!seeded && node.hostId !== this.folder.primaryHostId) return false;
    const { store } = this.coordinator.options;
    return (
      node.pending !== null ||
      store.node(this.folder.id, node.hostId).acked < seq
    );
  }

  async loop(): Promise<void> {
    const { store } = this.coordinator.options;
    try {
      while (!this.signal.aborted) {
        const seeded = store.isSeeded(this.folder.id);
        const seq = store.seq(this.folder.id);
        const now = this.coordinator.now();
        const waiting = [...this.nodes.values()].filter((node) =>
          this.due(node, seeded, seq),
        );
        // The node that has waited longest goes next, so one busy node cannot starve the rest.
        const next = waiting
          .filter((node) => node.retryAt <= now)
          .sort((a, b) => a.lastPassAt - b.lastPassAt)[0];
        if (next) {
          await this.pass(next);
          continue;
        }
        const wake = new Promise<void>((resolve) => (this.wakeUp = resolve));
        const soonest = Math.min(
          ...waiting.map((node) => node.retryAt - now),
          this.coordinator.timings.pollMs,
        );
        await sleep(Math.max(soonest, 10), this.signal, wake);
        this.wakeUp = null;
      }
    } finally {
      await Promise.all(
        [...this.nodes.values()].map((node) => this.abortUploads(node)),
      );
    }
  }

  private async abortUploads(node: NodeRuntime): Promise<void> {
    const uploads = [...node.uploads.values()];
    node.uploads.clear();
    await Promise.all(uploads.map((transfer) => transfer.writer.abort()));
  }

  private async pass(node: NodeRuntime): Promise<void> {
    const { coordinator, folder, signal } = this;
    const { store, host } = coordinator.options;
    const scope = node.pending;
    node.pending = null;
    node.passing = true;
    const startedAt = coordinator.tick();
    node.lastPassAt = startedAt;
    if (scope === "all") node.fullStartedAt = startedAt;
    coordinator.changed();
    try {
      if (scope === "all") await coordinator.ensureWatches(node.hostId);
      const result = await reconcileNode({
        store,
        host,
        folder,
        hostId: node.hostId,
        root: node.root,
        otherRoots: coordinator.getConfig().flatMap((other) =>
          other.id === folder.id
            ? []
            : other.nodes
                .filter((entry) => entry.hostId === node.hostId)
                .map((entry) => entry.path),
        ),
        scope: scope === null || scope === "all" ? scope : [...scope],
        signal,
        now: coordinator.now,
        sliceMs: coordinator.timings.sliceMs,
        transfers: node.transfers,
        uploads: node.uploads,
      });
      const seeding =
        node.hostId === folder.primaryHostId && !store.isSeeded(folder.id);
      if (
        scope === "all" &&
        node.hostId === folder.primaryHostId &&
        result.acked !== null
      )
        store.markSeeded(folder.id);
      if (result.deferred.length > 0)
        node.pending = merge(node.pending, result.deferred);
      if (result.retry.length > 0)
        node.pending = merge(node.pending, result.retry);
      if (seeding && result.acked === null)
        node.pending = merge(node.pending, "all");
      node.error =
        result.blocked > 0
          ? `${result.blocked} path(s) cannot be written: a symlink or file is in the way`
          : null;
      if (result.blocked > 0 || result.retry.length > 0) {
        if (result.blocked > 0) node.failedAt = startedAt;
        this.backoff(node);
      } else if (result.more) {
        // A finished transfer slice: yield, then continue without delay.
        node.retryAt = 0;
      } else {
        node.failures = 0;
        node.retryAt = 0;
        if (node.pending === null && node.fullStartedAt > 0)
          node.syncedSince = node.fullStartedAt;
      }
    } catch (error) {
      // A failed RPC may have written its chunk; retry from a fresh temporary file.
      node.transfers.clear();
      await this.abortUploads(node);
      if (signal.aborted) return;
      node.error =
        error instanceof NodeError
          ? error.message
          : `Sync failed: ${safeMessage(error)}`;
      node.failedAt = startedAt;
      if (scope !== null)
        node.pending = merge(
          node.pending,
          scope === "all" ? "all" : [...scope],
        );
      this.backoff(node);
      coordinator.options.log(
        `folder ${folder.id} on ${node.hostId}: ${safeMessage(error)}`,
      );
    } finally {
      node.passing = false;
      if (!signal.aborted) coordinator.changed();
    }
  }

  private backoff(node: NodeRuntime): void {
    const { retryMs, maxBackoffMs } = this.coordinator.timings;
    node.retryAt =
      this.coordinator.now() +
      Math.min(maxBackoffMs, retryMs * 2 ** node.failures);
    node.failures += 1;
  }
}
