// The settled-thread store. This state lives in the plugin's own database,
// never on bb's thread — uninstalling the plugin takes it with it.
//
// Two override kinds, because auto-settle needs both directions: "settled"
// parks a thread the timer would have kept, and "active" un-parks one the
// timer would otherwise re-settle on the next render.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
// Relative on purpose: a path install loads server.ts directly, where the
// bundler's "@/" alias does not exist.
import { pinnedRootIds } from "./lib/pinned-order";
import { homeSegmentUnder } from "./lib/assistant-identity";
import { assistantConversationContext, assistantDestinationSchema, assistantMachineSchema } from "./lib/assistant-conversation";
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
  threadPullRequests: {
    input: z.object({ threadIds: z.array(z.string().trim().min(1)).max(100) }),
    output: z.object({
      rows: z.array(z.object({
        threadId: z.string(),
        pullRequest: z.object({
          number: z.number().int().positive(),
          title: z.string(),
          url: z.string(),
          state: z.enum(["open", "draft", "closed", "merged"]),
        }).nullable(),
      })),
    }),
  },
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
      /** Stable across machines; null when the home cannot be derived. */
      identity: z.string().nullable(),
      sourceHostId: z.string(),
      machines: z.array(assistantMachineSchema),
      /** The mapped journal vault on the source host. */
      vaultPath: z.string().nullable(),
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
  assistantDestination: {
    input: z.object({ threadId: z.string().trim().min(1), hostId: z.string().trim().min(1) }),
    output: assistantDestinationSchema,
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
  assistantIdentities: {
    input: z.object({
      environmentIds: z.array(z.string().trim().min(1)).max(100),
    }),
    output: z.object({
      rows: z.array(
        z.object({ environmentId: z.string(), identity: z.string() }),
      ),
    }),
  },
  listAssistantSubtitles: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({ identity: z.string(), subtitle: z.string() }),
      ),
    }),
  },
  assistantOrder: {
    input: z.object({}),
    output: z.object({ ids: z.array(z.string()) }),
  },
  setAssistantOrder: {
    input: z.object({
      identities: z.array(z.string().trim().min(1)).max(200),
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
      request: z.object({
        projectId: z.string().min(1),
        providerId: z.string().min(1),
        model: z.string(),
        reasoningLevel: z.string(),
        permissionMode: z.string(),
        serviceTier: z.string().optional(),
        executionInputSources: z.unknown(),
        environment: z.unknown(),
        input: z.array(z.unknown()).min(1),
        sendAt: z.number().optional(),
      }),
      destinationHostId: z.string().trim().min(1),
      homePath: z.string().min(1),
      archiveSource: z.boolean(),
    }),
    output: z.object({ newThreadId: z.string(), archivedSource: z.boolean(), archiveError: z.string().optional() }),
  },
});

export type PipelinePullRequest = NonNullable<
  z.infer<typeof boardRpcContract.threadPullRequests.output>["rows"][number]["pullRequest"]
>;

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
    // Applied SQL is hashed; preserve the historical column names here.
    // The guarded rename below converts them to stable identity keys.
    `CREATE TABLE IF NOT EXISTS assistant_subtitles (
       environment_id TEXT PRIMARY KEY,
       subtitle       TEXT NOT NULL,
       at             INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS assistant_order (
       environment_id TEXT PRIMARY KEY,
       rank           INTEGER NOT NULL
     )`,
    // One row once the legacy environment-id keys have been rewritten.
    `CREATE TABLE IF NOT EXISTS assistant_key_migration (
       done INTEGER NOT NULL
     )`,
  ]);

  // Tables that predate identity keys store environment ids in a column of
  // the same role; rename the column first, then rewrite the values below.
  for (const table of ["assistant_subtitles", "assistant_order"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === "environment_id")) {
      db.prepare(
        `ALTER TABLE ${table} RENAME COLUMN environment_id TO identity`,
      ).run();
    }
  }

  // Identity comes from the environment plus its project's registered
  // sources, and sources change when a machine is added — so the cache lives
  // for a minute, not forever. Environment facts themselves are stable.
  const IDENTITY_TTL_MS = 60_000;
  interface ResolvedIdentity {
    /** False when the lookup itself failed — not an answer, a retry. */
    ok: boolean;
    /** Set iff the environment sits in a home of its project. */
    identity: string | null;
    /** True when a registered source on this host is all that's missing. */
    awaitingSource: boolean;
  }
  const identityCache = new Map<
    string,
    { at: number; resolved: ResolvedIdentity }
  >();
  const identityOfEnvironment = async (
    environmentId: string,
  ): Promise<ResolvedIdentity> => {
    const cached = identityCache.get(environmentId);
    if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) {
      return cached.resolved;
    }
    let resolved: ResolvedIdentity = { ok: false, identity: null, awaitingSource: false };
    try {
      const env = await bb.sdk.environments.get({ environmentId });
      let sources: Array<{ hostId: string; path: string }>;
      try {
        sources = (
          await bb.sdk.projects.get({ projectId: env.projectId })
        ).sources;
      } catch (error) {
        // A project lookup hiccup is transient; retry, keeping the key.
        bb.log.warn(
          `assistant identity for ${environmentId} unresolved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        identityCache.set(environmentId, { at: Date.now(), resolved });
        return resolved;
      }
      const source = sources.find(
        (candidate: { hostId: string }) => candidate.hostId === env.hostId,
      );
      const segment =
        source && env.path ? homeSegmentUnder(env.path, source.path) : null;
      resolved = {
        ok: true,
        identity: segment === null ? null : `${env.projectId}:${segment}`,
        awaitingSource: source === undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) {
        // The environment is gone for good: an answer, not a failure. Its
        // rows keep their key.
        resolved = { ok: true, identity: null, awaitingSource: false };
      } else {
        bb.log.warn(`assistant identity for ${environmentId} unresolved: ${message}`);
      }
    }
    identityCache.set(environmentId, { at: Date.now(), resolved });
    return resolved;
  };

  // Storage keys: the stable identity when the environment resolves to one,
  // the environment id otherwise — a mishomed or source-less environment
  // keeps working per-environment instead of pretending to be an assistant.
  // A failed lookup also lands here, so displays degrade instead of breaking.
  const storageKeyOfEnvironment = async (
    environmentId: string,
  ): Promise<string> =>
    (await identityOfEnvironment(environmentId)).identity ?? environmentId;

  // One-time rewrite of legacy environment-id keys. The pass resolves every
  // legacy key first, then re-reads the tables and rewrites synchronously:
  // a user edit landing mid-pass is re-read instead of clobbered, and one
  // landing after the rewrite simply wins the database.
  //
  // A failed lookup is not an answer, and neither is an environment whose
  // host has no registered source yet — both keep the pass unfinished, so
  // the next start retries and rows move to their identities as soon as the
  // sources exist. Environments that resolve to no home (mishomed, or gone
  // for good) keep their environment id and do finish the pass.
  const migrateIdentityKeys = async (): Promise<void> => {
    if (db.prepare(`SELECT done FROM assistant_key_migration`).get()) return;
    try {
      const legacyKeys = (
        db
          .prepare(
            `SELECT identity FROM assistant_subtitles UNION SELECT identity FROM assistant_order`,
          )
          .all() as Array<{ identity: string }>
      )
        .map((row) => row.identity)
        // Already-migrated keys carry a project id and a colon; only
        // environment ids ever need resolving, on this or a retry pass.
        .filter((key) => !key.includes(":"));
      const resolved = await Promise.all(
        legacyKeys.map((key) => identityOfEnvironment(key)),
      );
      const translation = new Map<string, string>();
      legacyKeys.forEach((key, index) => {
        const entry = resolved[index];
        if (entry.ok && entry.identity !== null) {
          translation.set(key, entry.identity);
        }
      });
      const pending = legacyKeys.filter(
        (_, index) =>
          !resolved[index].ok ||
          (resolved[index].identity === null && resolved[index].awaitingSource),
      );

      // Past this point nothing awaits: re-read what actually is there now
      // and replace it in one synchronous sweep.
      const subtitles = db
        .prepare(`SELECT identity, subtitle, at FROM assistant_subtitles ORDER BY at`)
        .all() as Array<{ identity: string; subtitle: string; at: number }>;
      const order = db
        .prepare(`SELECT identity, rank FROM assistant_order ORDER BY rank`)
        .all() as Array<{ identity: string; rank: number }>;
      // Two old environments can map to one identity; the newest subtitle
      // wins, matching how the display treats stale ids. Keys the resolver
      // did not translate (written after the pass began, or final
      // no-identity keys) pass through unchanged.
      const kept = new Map<string, { subtitle: string; at: number }>();
      subtitles.forEach((row) => {
        kept.set(translation.get(row.identity) ?? row.identity, row);
      });
      db.prepare(`DELETE FROM assistant_subtitles`).run();
      const insertSubtitle = db.prepare(
        `INSERT INTO assistant_subtitles (identity, subtitle, at) VALUES (?, ?, ?)`,
      );
      for (const [identity, row] of kept) {
        insertSubtitle.run(identity, row.subtitle, row.at);
      }
      const ranks = new Map<string, number>();
      order.forEach((row) => {
        ranks.set(translation.get(row.identity) ?? row.identity, row.rank);
      });
      db.prepare(`DELETE FROM assistant_order`).run();
      const insertOrder = db.prepare(
        `INSERT INTO assistant_order (identity, rank) VALUES (?, ?)`,
      );
      [...ranks.entries()]
        .sort((a, b) => a[1] - b[1])
        .forEach(([identity], rank) => insertOrder.run(identity, rank));

      if (pending.length > 0) {
        bb.log.warn(
          `assistant key migration deferred: ${pending.length} keys awaiting sources or lookups`,
        );
        return;
      }
      db.prepare(`INSERT INTO assistant_key_migration (done) VALUES (1)`).run();
      bb.realtime.publish(SUBTITLE_CHANNEL, {});
      bb.realtime.publish(ASSISTANT_ORDER_CHANNEL, {});
    } catch (error) {
      // No flag row: the next start retries.
      bb.log.warn(
        `assistant key migration deferred: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  // Off the synchronous startup path: the pass reads the tables only after
  // plugin() has returned, and the flag row makes it idempotent.
  void Promise.resolve().then(() => migrateIdentityKeys());

  const readAssistantOrder = (): string[] =>
    (
      db
        .prepare(
          `SELECT identity FROM assistant_order ORDER BY rank`,
        )
        .all() as Array<{ identity: string }>
    ).map((row) => row.identity);

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
  // thread to its home's identity; empty subtitle clears.
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
    const identity = await storageKeyOfEnvironment(thread.environmentId);
    if (subtitle === "") {
      db.prepare(
        `DELETE FROM assistant_subtitles WHERE identity = ?`,
      ).run(identity);
    } else {
      db.prepare(
        `INSERT INTO assistant_subtitles (identity, subtitle, at) VALUES (?, ?, ?)
         ON CONFLICT(identity) DO UPDATE SET
           subtitle = excluded.subtitle,
           at = excluded.at`,
      ).run(identity, subtitle, Date.now());
    }
    bb.realtime.publish(SUBTITLE_CHANNEL, { identity });
    return identity;
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
                  `SELECT subtitle FROM assistant_subtitles WHERE identity = ?`,
                )
                .get(
                  await storageKeyOfEnvironment(thread.environmentId),
                ) as { subtitle: string } | undefined)
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
    threadPullRequests(input) {
      return bb.sdk.plugins.callRpc({
        pluginId: "pipeline",
        method: "threadPullRequests",
        input,
        outputSchema: boardRpcContract.threadPullRequests.output,
      });
    },
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
    async assistantSeeds({ threadId }) {
      const context = await assistantConversationContext(bb, threadId);
      // A source conversation can outlive its provider; use normal composer defaults then.
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId }).catch((error: unknown) => {
        bb.log.warn(`Could not seed execution options for ${threadId}: ${String(error)}`);
        return null;
      });
      return {
        title: context.thread.title,
        projectId: context.thread.projectId,
        environmentId: context.env.id,
        sourceHostId: context.env.hostId,
        machines: context.machines,
        identity: context.identity,
        vaultPath: context.machines.find((host) => host.hostId === context.env.hostId)?.vaultPath ?? null,
        providerId: context.thread.providerId,
        ...(options ? {
          model: options.model,
          reasoningLevel: options.reasoningLevel,
          permissionMode: options.permissionMode,
          serviceTier: options.serviceTier,
        } : {}),
        homePath: context.env.path,
        homes: [{ name: context.segment, path: context.env.path! }],
        targetingAutomations: await targetingAutomationsOf(bb, threadId),
      };
    },
    async assistantDestination({ threadId, hostId }) {
      return (await assistantConversationContext(bb, threadId)).destination(hostId);
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
    // environmentId → stable assistant identity, for rows the board has.
    // Environments without a stable identity fall back to their own id, the
    // same key the stores use for them.
    async assistantIdentities({ environmentIds }) {
      const rows = await Promise.all(
        [...new Set(environmentIds)].map(async (environmentId) => ({
          environmentId,
          identity: await storageKeyOfEnvironment(environmentId),
        })),
      );
      return { rows };
    },
    async listAssistantSubtitles() {
      const rows = (
        db
          .prepare(`SELECT identity, subtitle FROM assistant_subtitles`)
          .all() as Array<{ identity: string; subtitle: string }>
      ).map((row) => ({
        identity: row.identity,
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
    async setAssistantOrder({ identities }) {
      db.prepare(`DELETE FROM assistant_order`).run();
      const insert = db.prepare(
        `INSERT INTO assistant_order (identity, rank) VALUES (?, ?)`,
      );
      [...new Set(identities)].forEach((identity, rank) => {
        insert.run(identity, rank);
      });
      bb.realtime.publish(ASSISTANT_ORDER_CHANNEL, {});
      return { ids: readAssistantOrder() };
    },
    async createReplacementThread({ replaceThreadId, request, destinationHostId, homePath, archiveSource }) {
      const context = await assistantConversationContext(bb, replaceThreadId);
      if (request.projectId !== context.thread.projectId)
        throw new Error("Keep the assistants project selected");
      if (archiveSource && destinationHostId !== context.env.hostId)
        throw new Error("Starting on another machine keeps the source conversation intact");
      await context.validate(destinationHostId, homePath);
      // Copy composer selections only. Filing and lifecycle always belong to this flow.
      const fresh = await bb.sdk.threads.spawn({
        projectId: request.projectId,
        providerId: request.providerId,
        model: request.model,
        reasoningLevel: request.reasoningLevel,
        permissionMode: request.permissionMode,
        serviceTier: request.serviceTier,
        executionInputSources: request.executionInputSources,
        input: request.input,
        sendAt: request.sendAt,
        title: context.thread.title ?? undefined,
        environment: { type: "host", hostId: destinationHostId, workspace: { type: "unmanaged", path: homePath } },
      } as Parameters<typeof bb.sdk.threads.spawn>[0]);
      if (archiveSource) {
        try {
          await bb.sdk.threads.archive({ threadId: replaceThreadId });
        } catch (error) {
          return { newThreadId: fresh.id, archivedSource: false, archiveError: String(error) };
        }
      }
      return { newThreadId: fresh.id, archivedSource: archiveSource };
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
