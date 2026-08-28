// The settled-thread store. This state lives in the plugin's own database,
// never on bb's thread — uninstalling the plugin takes it with it.
//
// Two override kinds, because auto-settle needs both directions: "settled"
// parks a thread the timer would have kept, and "active" un-parks one the
// timer would otherwise re-settle on the next render.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
// Relative on purpose: a path install loads server.ts directly, where the
// bundler's "@/" alias does not exist.
import { pinnedRootIds } from "./lib/pinned-order";
import {
  getProjectPathError,
  normalizeProjectPath,
  projectNameFromPath,
} from "./lib/project-path";
import {
  getFolderNameError,
  joinHostPath,
} from "./lib/project-browser-path";

const threadIdInput = z.object({ threadId: z.string().trim().min(1) });
const pinnedOrderOutput = z.object({ ids: z.array(z.string()) });

// The automations plugin's overview RPC. Read-only, cross-plugin: this shape
// is a subset of its real output, enough to name every automation whose
// agent execution still points at a thread being restarted.
const automationsOverviewOutput = z.object({
  automations: z.array(
    z.object({
      automation: z.object({
        id: z.string(),
        name: z.string(),
        execution: z
          .object({
            mode: z.string(),
            targetThreadId: z.string().optional(),
          })
          .passthrough(),
      }),
    }),
  ),
});

/**
 * Every automation whose agent execution targets `threadId`. Falls back to
 * an empty list when the automations plugin is down — the restart dialog
 * must never be blocked by a naming nicety.
 */
async function targetingAutomationsOf(
  bb: BbPluginApi,
  threadId: string,
): Promise<Array<{ id: string; name: string }>> {
  try {
    const { automations } = await bb.sdk.plugins.callRpc({
      pluginId: "automations",
      method: "automations_overview",
      input: null,
      outputSchema: automationsOverviewOutput,
    });
    return automations
      .map((row) => row.automation)
      .filter(
        (automation) =>
          automation.execution.mode === "agent" &&
          automation.execution.targetThreadId === threadId,
      )
      .map((automation) => ({ id: automation.id, name: automation.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    bb.log.warn(
      `Could not list automations targeting ${threadId} from automations plugin: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

export const boardRpcContract = defineRpcContract({
  projectCreationContext: {
    input: z.object({}),
    output: z.object({
      primaryHostId: z.string().nullable(),
      hosts: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  projectDirectory: {
    input: z.object({
      hostId: z.string().trim().min(1),
      path: z.string().nullable(),
    }),
    output: z.object({
      directory: z.string(),
      parent: z.string().nullable(),
      entries: z.array(z.object({ name: z.string(), path: z.string() })),
    }),
  },
  createProjectFolder: {
    input: z.object({
      hostId: z.string().trim().min(1),
      parentPath: z.string().trim().min(1),
      name: z.string(),
    }),
    output: z.object({ path: z.string() }),
  },
  addProject: {
    input: z.object({
      hostId: z.string().trim().min(1),
      path: z.string(),
    }),
    output: z.object({ projectId: z.string() }),
  },
  listOverrides: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          override: z.enum(["settled", "active"]),
          at: z.number(),
        }),
      ),
    }),
  },
  settle: { input: threadIdInput, output: z.object({ ok: z.boolean() }) },
  unsettle: { input: threadIdInput, output: z.object({ ok: z.boolean() }) },
  pinnedOrder: { input: z.object({}), output: pinnedOrderOutput },
  movePinned: {
    input: z.object({
      threadId: z.string().trim().min(1),
      previousThreadId: z.string().trim().min(1).nullable(),
      nextThreadId: z.string().trim().min(1).nullable(),
    }),
    output: pinnedOrderOutput,
  },
  assistantSeeds: {
    input: threadIdInput,
    output: z.object({
      title: z.string().nullable(),
      projectId: z.string(),
      environmentId: z.string(),
      providerId: z.string(),
      model: z.string().optional(),
      reasoningLevel: z.string().optional(),
      permissionMode: z.string().optional(),
      serviceTier: z.string().optional(),
      homePath: z.string().nullable(),
      homes: z.array(z.object({ name: z.string(), path: z.string() })),
      targetingAutomations: z.array(
        z.object({ id: z.string(), name: z.string() }),
      ),
    }),
  },
  listAssistantAvatars: {
    input: z.object({
      environmentIds: z.array(z.string().trim().min(1)).max(100),
    }),
    output: z.object({
      rows: z.array(
        z.object({ environmentId: z.string(), svg: z.string() }),
      ),
    }),
  },
  listAssistantSubtitles: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({ environmentId: z.string(), subtitle: z.string() }),
      ),
    }),
  },
  assistantOrder: {
    input: z.object({}),
    output: z.object({ ids: z.array(z.string()) }),
  },
  setAssistantOrder: {
    input: z.object({
      environmentIds: z.array(z.string().trim().min(1)).max(200),
    }),
    output: z.object({ ids: z.array(z.string()) }),
  },
  setAssistantSubtitle: {
    input: z.object({
      threadId: z.string().trim().min(1),
      subtitle: z.string().trim().max(200),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  createReplacementThread: {
    input: z.object({
      replaceThreadId: z.string().trim().min(1),
      title: z.string().nullable(),
      request: z.unknown(),
      homePath: z.string().trim().min(1).optional(),
    }),
    output: z.object({ newThreadId: z.string() }),
  },
});

/** Realtime channel the board re-reads overrides on. */
export const SETTLED_CHANNEL = "settled";

/** Realtime channel the board re-reads the pinned order on. */
export const PINNED_CHANNEL = "pinned-order";

/** Realtime channel the assistant list re-reads subtitles on. */
export const SUBTITLE_CHANNEL = "assistant-subtitles";

/** Realtime channel the Bots section re-reads its row order on. */
export const ASSISTANT_ORDER_CHANNEL = "assistant-order";

interface OverrideDbRow {
  thread_id: string;
  override: "settled" | "active";
  at: number;
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS thread_overrides (
       thread_id TEXT PRIMARY KEY,
       override  TEXT NOT NULL CHECK (override IN ('settled', 'active')),
       at        INTEGER NOT NULL
     )`,
    // Keyed by environment, not thread: an assistant is its home environment,
    // and threads are disposable — a subtitle must survive a thread restart.
    `CREATE TABLE IF NOT EXISTS assistant_subtitles (
       environment_id TEXT PRIMARY KEY,
       subtitle       TEXT NOT NULL,
       at             INTEGER NOT NULL
     )`,
    // The user's hand-picked Bots order. Environment-keyed like subtitles,
    // one row per rank; a write replaces the whole list.
    `CREATE TABLE IF NOT EXISTS assistant_order (
       environment_id TEXT PRIMARY KEY,
       rank           INTEGER NOT NULL
     )`,
  ]);

  const readAssistantOrder = (): string[] =>
    (
      db
        .prepare(
          `SELECT environment_id FROM assistant_order ORDER BY rank`,
        )
        .all() as Array<{ environment_id: string }>
    ).map((row) => row.environment_id);

  const write = (threadId: string, override: "settled" | "active"): void => {
    db.prepare(
      `INSERT INTO thread_overrides (thread_id, override, at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         override = excluded.override,
         at = excluded.at`,
    ).run(threadId, override, Date.now());
    bb.realtime.publish(SETTLED_CHANNEL, { threadId });
  };

  // Shared by the rpc (sidebar editor) and the CLI (agents). Resolves the
  // thread to its home environment; empty subtitle clears.
  const writeSubtitle = async (
    threadId: string,
    subtitle: string,
  ): Promise<string> => {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) {
      throw new Error(
        `thread ${threadId} has no environment — not an assistant home`,
      );
    }
    if (subtitle === "") {
      db.prepare(
        `DELETE FROM assistant_subtitles WHERE environment_id = ?`,
      ).run(thread.environmentId);
    } else {
      db.prepare(
        `INSERT INTO assistant_subtitles (environment_id, subtitle, at) VALUES (?, ?, ?)
         ON CONFLICT(environment_id) DO UPDATE SET
           subtitle = excluded.subtitle,
           at = excluded.at`,
      ).run(thread.environmentId, subtitle, Date.now());
    }
    bb.realtime.publish(SUBTITLE_CHANNEL, {
      environmentId: thread.environmentId,
    });
    return thread.environmentId;
  };

  // A directory is an assistant home when it carries its own identity file.
  const isAssistantHome = async (
    hostId: string,
    path: string,
  ): Promise<boolean> => {
    try {
      await bb.sdk.files.read({ hostId, path: `${path}/.pi/SYSTEM.md` });
      return true;
    } catch {
      return false;
    }
  };

  // Candidate homes for the ↻ dialog: the fleet root's subdirectories that
  // are homes. The fleet root is the environment's parent when the
  // environment is itself a home, else the environment directory — a
  // mishomed thread sits directly on the fleet root.
  const listAssistantHomes = async (
    hostId: string,
    environmentPath: string,
  ): Promise<Array<{ name: string; path: string }>> => {
    try {
      const here = await bb.sdk.hosts.directory({
        hostId,
        path: environmentPath,
      });
      const root = (await isAssistantHome(hostId, environmentPath))
        ? here.parent
        : here.directory;
      if (!root) return [];
      const listing =
        root === here.directory
          ? here
          : await bb.sdk.hosts.directory({ hostId, path: root });
      const dirs = listing.entries.filter(
        (entry) => entry.kind === "directory" && !entry.name.startsWith("."),
      );
      const flags = await Promise.all(
        dirs.map((dir) => isAssistantHome(hostId, dir.path)),
      );
      return dirs
        .filter((_, index) => flags[index])
        .map(({ name, path }) => ({ name, path }));
    } catch {
      return [];
    }
  };

  const SUBTITLE_USAGE =
    "usage: bb assistants subtitle <thread-id> [text… | --clear]";
  bb.cli.register({
    name: "assistants",
    summary: "Assistant sidebar helpers",
    commands: [
      {
        name: "subtitle",
        summary: "Show, set, or clear an assistant's sidebar subtitle",
        usage: SUBTITLE_USAGE,
      },
    ],
    run: async (argv) => {
      const [command, threadId, ...rest] = argv;
      if (command !== "subtitle" || !threadId) {
        return { exitCode: 1, stderr: `${SUBTITLE_USAGE}\n` };
      }
      try {
        if (rest.length === 0) {
          const thread = await bb.sdk.threads.get({ threadId });
          const row = thread.environmentId
            ? (db
                .prepare(
                  `SELECT subtitle FROM assistant_subtitles WHERE environment_id = ?`,
                )
                .get(thread.environmentId) as
                | { subtitle: string }
                | undefined)
            : undefined;
          return { exitCode: 0, stdout: `${row?.subtitle ?? "(none)"}\n` };
        }
        const subtitle =
          rest[0] === "--clear" ? "" : rest.join(" ").trim();
        if (subtitle.length > 200) {
          return {
            exitCode: 1,
            stderr: "subtitle is longer than 200 characters\n",
          };
        }
        await writeSubtitle(threadId, subtitle);
        return {
          exitCode: 0,
          stdout: subtitle
            ? `Subtitle set: ${subtitle}\n`
            : "Subtitle cleared\n",
        };
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : String(cause);
        return { exitCode: 1, stderr: `${message}\n` };
      }
    },
  });

  bb.rpc.register(boardRpcContract, {
    async projectCreationContext() {
      const [config, allHosts] = await Promise.all([
        bb.sdk.system.config(),
        bb.sdk.hosts.list(),
      ]);
      const hosts = allHosts
        .filter((host) => host.status === "connected")
        .map(({ id, name }) => ({ id, name }));
      const primaryHostId = hosts.some(
        (host) => host.id === config.primaryHostId,
      )
        ? config.primaryHostId
        : (hosts[0]?.id ?? null);
      return { primaryHostId, hosts };
    },
    async projectDirectory({ hostId, path }) {
      const listing = await bb.sdk.hosts.directory({
        hostId,
        ...(path ? { path } : {}),
      });
      return {
        directory: listing.directory,
        parent: listing.parent,
        entries: listing.entries
          .filter((entry) => entry.kind === "directory")
          .map(({ name, path: entryPath }) => ({ name, path: entryPath })),
      };
    },
    async createProjectFolder({ hostId, parentPath, name }) {
      const trimmedName = name.trim();
      const nameError = getFolderNameError(trimmedName);
      if (nameError) throw new Error(nameError);

      const path = joinHostPath(parentPath, trimmedName);
      await bb.sdk.files.mkdir({ hostId, path });
      return { path };
    },
    async addProject({ hostId, path }) {
      const pathError = getProjectPathError(path);
      if (pathError) throw new Error(pathError);

      const normalizedPath = normalizeProjectPath(path);
      const project = await bb.sdk.projects.create({
        name: projectNameFromPath(normalizedPath),
        source: { type: "local_path", hostId, path: normalizedPath },
      });
      return { projectId: project.id };
    },
    async listOverrides() {
      const rows = (
        db
          .prepare(`SELECT thread_id, override, at FROM thread_overrides`)
          .all() as OverrideDbRow[]
      ).map((row) => ({
        threadId: row.thread_id,
        override: row.override,
        at: row.at,
      }));
      return { rows };
    },
    async settle({ threadId }) {
      write(threadId, "settled");
      return { ok: true };
    },
    async unsettle({ threadId }) {
      write(threadId, "active");
      return { ok: true };
    },
    // Pin order is bb's, not ours: we read its list and write through its
    // reorder call. Nothing about it is stored in this plugin's database.
    async pinnedOrder() {
      return {
        ids: pinnedRootIds(await bb.sdk.threads.list({ archived: false })),
      };
    },
    async movePinned({ threadId, previousThreadId, nextThreadId }) {
      // Same derivation as the read. The app itself never trusts the response
      // array's order — it merges the returned sort keys and re-sorts — so
      // neither do we.
      const threads = await bb.sdk.threads.reorderPinned({
        threadId,
        previousThreadId,
        nextThreadId,
      });
      bb.realtime.publish(PINNED_CHANNEL, { threadId });
      return { ids: pinnedRootIds(threads) };
    },
    // An assistant is its home environment; threads are disposable. These two
    // back the ↻ dialog: seed bb's compose surface from the current thread,
    // then spawn the replacement from the typed message and archive the old
    // thread — a fresh thread born exactly like bb's default new-thread flow.
    async assistantSeeds({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) {
        throw new Error(
          `thread ${threadId} has no environment — not an assistant home`,
        );
      }
      const [options, env] = await Promise.all([
        bb.sdk.threads.defaultExecutionOptions({ threadId }),
        bb.sdk.environments.get({ environmentId: thread.environmentId }),
      ]);
      const homes = env.path
        ? await listAssistantHomes(env.hostId, env.path)
        : [];
      const targetingAutomations = await targetingAutomationsOf(bb, threadId);
      return {
        title: thread.title,
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
        model: options?.model,
        reasoningLevel: options?.reasoningLevel,
        permissionMode: options?.permissionMode,
        serviceTier: options?.serviceTier,
        homePath: env.path,
        homes,
        targetingAutomations,
      };
    },
    // An assistant's picture is a file it owns: <home>/avatar.svg. No store,
    // no upload — the assistant (or the user) writes the file and the sidebar
    // picks it up. Rendered via an <img> data URL, so embedded scripts are
    // inert. Missing or bogus files just mean initials.
    async listAssistantAvatars({ environmentIds }) {
      const rows = await Promise.all(
        [...new Set(environmentIds)].map(async (environmentId) => {
          try {
            const env = await bb.sdk.environments.get({ environmentId });
            if (!env.path) return null;
            const file = await bb.sdk.files.read({
              hostId: env.hostId,
              path: `${env.path}/avatar.svg`,
            });
            if (file.sizeBytes > 100_000) return null;
            const svg =
              file.contentEncoding === "base64"
                ? Buffer.from(file.content, "base64").toString("utf8")
                : file.content;
            const head = svg.trimStart().slice(0, 5).toLowerCase();
            if (!head.startsWith("<svg") && !head.startsWith("<?xml"))
              return null;
            return { environmentId, svg };
          } catch {
            return null;
          }
        }),
      );
      return { rows: rows.filter((row) => row !== null) };
    },
    async listAssistantSubtitles() {
      const rows = (
        db
          .prepare(`SELECT environment_id, subtitle FROM assistant_subtitles`)
          .all() as Array<{ environment_id: string; subtitle: string }>
      ).map((row) => ({
        environmentId: row.environment_id,
        subtitle: row.subtitle,
      }));
      return { rows };
    },
    async setAssistantSubtitle({ threadId, subtitle }) {
      await writeSubtitle(threadId, subtitle);
      return { ok: true };
    },
    async assistantOrder() {
      return { ids: readAssistantOrder() };
    },
    // The client sends the full displayed order after a drag; stored verbatim.
    // Ids the fleet no longer has just stop matching and the next write
    // clears them.
    async setAssistantOrder({ environmentIds }) {
      db.prepare(`DELETE FROM assistant_order`).run();
      const insert = db.prepare(
        `INSERT INTO assistant_order (environment_id, rank) VALUES (?, ?)`,
      );
      [...new Set(environmentIds)].forEach((environmentId, rank) => {
        insert.run(environmentId, rank);
      });
      bb.realtime.publish(ASSISTANT_ORDER_CHANNEL, {});
      return { ids: readAssistantOrder() };
    },
    async createReplacementThread({ replaceThreadId, title, request, homePath }) {
      // The dialog's Home choice wins over the composer's environment picker,
      // which cannot express a plain directory: unchanged path reuses the
      // current environment, a different path lets bb resolve it into one.
      let environment: Record<string, unknown> | undefined;
      if (homePath) {
        const thread = await bb.sdk.threads.get({ threadId: replaceThreadId });
        const env = thread.environmentId
          ? await bb.sdk.environments.get({
              environmentId: thread.environmentId,
            })
          : null;
        environment =
          env && env.path === homePath
            ? { type: "reuse", environmentId: env.id }
            : {
                type: "host",
                ...(env ? { hostId: env.hostId } : {}),
                workspace: { type: "unmanaged", path: homePath },
              };
      }
      const fresh = await bb.sdk.threads.spawn({
        ...(request as Record<string, unknown>),
        ...(environment ? { environment } : {}),
        title: title ?? undefined,
      } as Parameters<typeof bb.sdk.threads.spawn>[0]);
      await bb.sdk.threads.archive({ threadId: replaceThreadId });
      return { newThreadId: fresh.id };
    },
  });

  // A deleted thread must not leave an override behind that would park a
  // future thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    db.prepare(`DELETE FROM thread_overrides WHERE thread_id = ?`).run(
      thread.id,
    );
    bb.realtime.publish(SETTLED_CHANNEL, { threadId: thread.id });
  });
}
