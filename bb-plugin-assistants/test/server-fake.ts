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
}

export interface ServerApiHarness {
  db: Database.Database;
  /** The handlers the plugin registered, call them like the rpc would. */
  handlers: Record<string, (input: never) => Promise<unknown>>;
  publishes: Array<{ channel: string; payload: unknown }>;
  warnings: string[];
  /** Change what the SDK answers, then load the plugin fresh — a bb restart
   * with new facts. Identity caches do not survive a restart. */
  restart(next?: Partial<ServerApiOptions>): void;
}

export function serverApi(initial: ServerApiOptions = {}): ServerApiHarness {
  // On disk like the host's: memory files live beside the database.
  const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inbox-server-")), "data.db"));
  // Like bb's ledger: a restart runs only the statements not applied yet.
  let applied = 0;

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
          for (const statement of statements.slice(applied)) db.exec(statement);
          applied = statements.length;
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

  return {
    db,
    get handlers() {
      if (!registered) throw new Error("plugin did not register rpc handlers");
      return registered;
    },
    publishes,
    warnings,
    restart(next) {
      Object.assign(options, next);
      build();
    },
  };
}
