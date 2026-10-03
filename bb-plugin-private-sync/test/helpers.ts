import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { ExperimentalHostWatchListener } from "@get-bb/plugin-sdk";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { FolderConfig } from "../contract";
import { createHostEntry } from "../host";
import { Coordinator, type Timings } from "../lib/coordinator";
import type { HostClient } from "../lib/reconcile";
import { MIGRATIONS, Store } from "../lib/store";

type Harness = ReturnType<
  typeof experimental_createHostEntryHarness<
    ReturnType<typeof createHostEntry>["contract"],
    NonNullable<ReturnType<typeof createHostEntry>["experimental_signals"]>
  >
>;

export interface Machine {
  id: string;
  root: string;
  online: boolean;
  harness: Harness;
  watchers: ExperimentalHostWatchListener[];
  /** Runs before each host call reaches this machine; lets a test act mid-transfer. */
  before?: (method: string, input: any) => void | Promise<void>;
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "private-sync-test-"));
}

export async function machine(base: string, id: string): Promise<Machine> {
  const root = join(base, id, "root");
  const dataDir = join(base, id, "data");
  const workerTemp = join(base, id, "tmp");
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(workerTemp, { recursive: true }),
  ]);
  const watchers: ExperimentalHostWatchListener[] = [];
  const harness = experimental_createHostEntryHarness(createHostEntry(), {
    experimental_paths: { dataDir, tempDir: workerTemp },
    experimental_watch: (_options, listener) => {
      watchers.push(listener);
      return {
        dispose: async () =>
          void watchers.splice(watchers.indexOf(listener), 1),
      };
    },
  });
  return { id, root, online: true, harness, watchers };
}

/** Routes typed host calls to each machine's in-process host entry, like the daemon would. */
export function hostClient(machines: Machine[]): HostClient {
  return {
    call: (async (
      method: string,
      input: unknown,
      options: { hostId: string },
    ) => {
      const target = machines.find(
        (candidate) => candidate.id === options.hostId,
      );
      if (!target?.online) throw new Error(`host ${options.hostId} is offline`);
      await target.before?.(method, input);
      return (
        target.harness.experimental_call as (
          m: string,
          i: unknown,
        ) => Promise<unknown>
      )(method, input);
    }) as HostClient["call"],
  };
}

export function openStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // Same append-only contract as bb.storage.migrate: apply only statements not yet run.
  const applied = db.pragma("user_version", { simple: true }) as number;
  for (const statement of MIGRATIONS.slice(applied)) db.exec(statement);
  db.pragma(`user_version = ${MIGRATIONS.length}`);
  return new Store(db);
}

export function folderOf(
  machines: Machine[],
  overrides: Partial<FolderConfig> = {},
): FolderConfig {
  return {
    id: "notes",
    label: "Notes",
    primaryHostId: machines[0]!.id,
    nodes: machines.map((m) => ({ hostId: m.id, path: m.root })),
    ignorePaths: [],
    ...overrides,
  };
}

/** A running coordinator over real stores and host entries, with fast timings. */
export function startCoordinator(
  store: Store,
  machines: Machine[],
  folders: FolderConfig[],
  timings: Partial<Timings> = {},
) {
  const logs: string[] = [];
  const coordinator = new Coordinator({
    store,
    host: hostClient(machines),
    listHosts: async () =>
      machines.map((m) => ({
        id: m.id,
        status: m.online ? "connected" : "disconnected",
      })),
    log: (message) => logs.push(message),
    onStatusChange: () => {},
    timings: { pollMs: 20, retryMs: 10, maxBackoffMs: 100, ...timings },
  });
  const controller = new AbortController();
  const running = coordinator.run(controller.signal);
  coordinator.apply({
    enabled: true,
    paused: false,
    folders,
    configError: null,
  });
  return {
    coordinator,
    logs,
    stop: async () => {
      controller.abort();
      await running;
    },
  };
}

export async function put(
  m: Machine,
  path: string,
  content: string | Buffer,
): Promise<void> {
  const abs = join(m.root, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

export async function read(m: Machine, path: string): Promise<string | null> {
  return readFile(join(m.root, path), "utf8").catch(() => null);
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function linkTarget(
  m: Machine,
  path: string,
): Promise<string | null> {
  return readlink(join(m.root, path)).catch(() => null);
}

export async function cleanup(base: string): Promise<void> {
  await rm(base, { recursive: true, force: true });
}

/** Paths of conflict copies for `stem` in a directory listing. */
export function conflictCopies(paths: string[], stem: string): string[] {
  return paths.filter((path) => path.startsWith(`${stem}.sync-conflict-`));
}
