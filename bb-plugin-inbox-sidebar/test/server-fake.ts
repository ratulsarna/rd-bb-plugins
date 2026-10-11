import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "@/server";

/**
 * A `BbPluginApi` over a real in-memory database and the smallest SDK the
 * server actually calls. Tests seed `environments`, `projects`, and `threads`
 * with plain records; anything absent behaves like bb does — throws.
 */
export interface ServerApiOptions {
  environments?: Record<string, Record<string, unknown>>;
  projects?: Array<Record<string, unknown>>;
  threads?: Record<string, Record<string, unknown>>;
  privateSyncStatus?: unknown;
  machineDirectory?: unknown;
  /** Tables to create before the plugin migrates, e.g. the legacy schema. */
  preMigrate?: string[];
  /** Override the environment lookup entirely, to hold the migration's
   * SDK reads open while a user mutation races them. */
  environmentsGet?: (
    environmentId: string,
  ) => Promise<Record<string, unknown>>;
}

export interface ServerApiHarness {
  db: Database.Database;
  /** The handlers the plugin registered, call them like the rpc would. */
  handlers: Record<string, (input: never) => Promise<unknown>>;
  publishes: Array<{ channel: string; payload: unknown }>;
  warnings: string[];
  flush(): Promise<void>;
  /** Change what the SDK answers, then load the plugin fresh — a bb restart
   * with new facts. Identity caches do not survive a restart. */
  restart(next?: Partial<ServerApiOptions>): void;
}

export function serverApi(initial: ServerApiOptions = {}): ServerApiHarness {
  // On disk like the host's: memory files live beside the database.
  const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inbox-server-")), "data.db"));
  for (const statement of initial.preMigrate ?? []) db.exec(statement);

  const publishes: Array<{ channel: string; payload: unknown }> = [];
  const warnings: string[] = [];
  const options: ServerApiOptions = { ...initial };
  let registered: Record<string, (input: never) => Promise<unknown>> | null =
    null;

  const build = () => {
    registered = null;
    const api = {
      storage: {
        database: () => db,
        migrate: (_db: unknown, statements: string[]) => {
          for (const statement of statements) db.exec(statement);
        },
      },
      log: {
        warn: (message: string) => warnings.push(message),
        info: () => {},
        error: () => {},
      },
      realtime: {
        publish: (channel: string, payload: unknown) =>
          publishes.push({ channel, payload }),
      },
      rpc: {
        register: (
          _contract: unknown,
          handlers: Record<string, (input: never) => Promise<unknown>>,
        ) => {
          registered = handlers;
        },
      },
      cli: { register: () => {} },
      events: { on: () => {} },
      experimental_hooks: { on: () => {}, recheck: async () => {} },
      onDispose: () => {},
      settings: {
        define: (descriptors: Record<string, { default?: unknown }>) => ({
          get: async () => Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.default])),
          onChange: () => {},
        }),
      },
      sdk: {
        environments: {
          get: async ({ environmentId }: { environmentId: string }) => {
            if (options.environmentsGet) {
              return options.environmentsGet(environmentId);
            }
            const env = options.environments?.[environmentId];
            if (!env) throw new Error(`environment ${environmentId} not found`);
            return env;
          },
        },
        projects: {
          get: async ({ projectId }: { projectId: string }) => {
            const project = options.projects?.find((p) => p.id === projectId);
            if (!project) throw new Error(`project ${projectId} not found`);
            return project;
          },
          list: async () => options.projects ?? [],
          create: async () => {
            throw new Error("not needed");
          },
        },
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            const thread = options.threads?.[threadId];
            if (!thread) throw new Error(`thread ${threadId} not found`);
            return thread;
          },
          defaultExecutionOptions: async () => null,
        },
        plugins: {
          callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
            if (pluginId === "private-sync") {
              if (method === "status") return options.privateSyncStatus;
              if (method === "machineDirectory") return options.machineDirectory;
            }
            throw new Error("no cross-plugin RPC fixture");
          },
        },
      },
    } as unknown as BbPluginApi;
    plugin(api);
  };

  build();

  // The legacy-key migration runs in the background; let its promises land.
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  return {
    db,
    get handlers() {
      if (!registered) throw new Error("plugin did not register rpc handlers");
      return registered;
    },
    publishes,
    warnings,
    flush,
    restart(next) {
      Object.assign(options, next);
      build();
    },
  };
}
