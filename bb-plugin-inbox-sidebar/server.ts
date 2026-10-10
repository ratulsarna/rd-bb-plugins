// The settled-thread store. This state lives in the plugin's own database,
// never on bb's thread — uninstalling the plugin takes it with it.
//
// Three override kinds, one row per thread. Auto-settle needs both
// directions: "settled" parks a thread the timer would have kept, and
// "active" un-parks one the timer would otherwise re-settle on the next
// render. "snoozed" hides a thread until `until`; once that has passed the
// row is a woken snooze until the thread is opened.
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
// Relative on purpose: a path install loads server.ts directly, where the
// bundler's "@/" alias does not exist.
import { pinnedRootIds } from "./lib/pinned-order";
import { homeSegmentUnder } from "./lib/assistant-identity";
import {
  assistantConversationContext,
  assistantDestinationSchema,
  assistantMachineSchema,
  repointAutomations,
  targetingAutomationsOf,
} from "./lib/assistant-conversation";
import {
  getProjectPathError,
  normalizeProjectPath,
  projectNameFromPath,
} from "./lib/project-path";
import {
  getFolderNameError,
  joinHostPath,
} from "./lib/project-browser-path";
import { handover, type Place } from "./memory/handover";
import { MEMORY_CHANNEL, MemoryService } from "./memory/service";

const threadIdInput = z.object({ threadId: z.string().trim().min(1) });
const snoozeInput = threadIdInput.extend({ until: z.number().int().positive() });
const pinnedOrderOutput = z.object({ ids: z.array(z.string()) });

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
        z.discriminatedUnion("override", [
          z.object({
            threadId: z.string(),
            override: z.enum(["settled", "active"]),
            at: z.number(),
          }),
          z.object({
            threadId: z.string(),
            override: z.literal("snoozed"),
            at: z.number(),
            until: z.number(),
          }),
        ]),
      ),
    }),
  },
  settle: { input: threadIdInput, output: z.object({ ok: z.boolean() }) },
  unsettle: { input: threadIdInput, output: z.object({ ok: z.boolean() }) },
  snooze: { input: snoozeInput, output: z.object({ ok: z.boolean() }) },
  wake: { input: threadIdInput, output: z.object({ ok: z.boolean() }) },
  acknowledgeWake: { input: snoozeInput, output: z.object({ ok: z.boolean() }) },
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
      /** Memory is on: the handover adds the view to the first message. */
      memory: z.boolean(),
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
    }),
    output: z.object({ newThreadId: z.string(), warning: z.string().optional() }),
  },
  assistantMemory: {
    input: z.object({}),
    output: z.object({
      rows: z.array(z.object({ identity: z.string(), warning: z.string().nullable() })),
    }),
  },
  pastAssistantThreads: {
    input: threadIdInput,
    output: z.object({
      rows: z.array(z.object({ id: z.string(), createdAt: z.number(), archivedAt: z.number() })),
    }),
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

export { MEMORY_CHANNEL };

type OverrideDbRow =
  | { thread_id: string; override: "settled" | "active"; at: number; until: null }
  | { thread_id: string; override: "snoozed"; at: number; until: number };

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
    // Snoozes join settle marks in one row per thread, so a thread is never
    // settled and snoozed at once. SQLite cannot widen a CHECK in place.
    `CREATE TABLE thread_overrides_next (
       thread_id TEXT PRIMARY KEY,
       override  TEXT NOT NULL CHECK (override IN ('settled', 'active', 'snoozed')),
       at        INTEGER NOT NULL,
       until     INTEGER,
       CHECK ((override = 'snoozed') = (until IS NOT NULL))
     )`,
    `INSERT INTO thread_overrides_next (thread_id, override, at)
       SELECT thread_id, override, at FROM thread_overrides`,
    `DROP TABLE thread_overrides`,
    `ALTER TABLE thread_overrides_next RENAME TO thread_overrides`,
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
    if (resolved.ok && !resolved.awaitingSource) {
      identityCache.set(environmentId, { at: Date.now(), resolved });
    }
    return resolved;
  };

  // Displays may fall back; writes and drag readiness require an answer so
  // a transient lookup or missing source cannot strand metadata under an id.
  const storageKeyOfEnvironment = async (
    environmentId: string,
    requireResolved = false,
  ): Promise<string> => {
    const resolved = await identityOfEnvironment(environmentId);
    if (requireResolved && (!resolved.ok || resolved.awaitingSource)) {
      throw new Error(`assistant identity for ${environmentId} unresolved; retry when its environment and project source are available`);
    }
    return resolved.identity ?? environmentId;
  };

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
      db.transaction(() => {
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
          // Keep clears until every alias is resolved, including across restarts.
          if (row.subtitle !== "" || pending.length > 0) {
            insertSubtitle.run(identity, row.subtitle, row.at);
          }
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

        if (pending.length === 0) {
          db.prepare(`INSERT INTO assistant_key_migration (done) VALUES (1)`).run();
        }
      })();
      bb.realtime.publish(SUBTITLE_CHANNEL, {});
      bb.realtime.publish(ASSISTANT_ORDER_CHANNEL, {});
      if (pending.length > 0) {
        bb.log.warn(
          `assistant key migration deferred: ${pending.length} keys awaiting sources or lookups`,
        );
        return;
      }
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

  const write = (
    threadId: string,
    override: "settled" | "active" | "snoozed",
    until: number | null = null,
  ): void => {
    db.prepare(
      `INSERT INTO thread_overrides (thread_id, override, at, until) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         override = excluded.override,
         at = excluded.at,
         until = excluded.until`,
    ).run(threadId, override, Date.now(), until);
    bb.realtime.publish(SETTLED_CHANNEL, { threadId });
  };

  // Ends the live snoozes among `threadIds` now. `occurredAt` is when the
  // cause happened: events reach us late, so a request that arrived before
  // the user snoozed must not end that snooze.
  const wakeSnoozed = (threadIds: readonly string[], occurredAt: number): void => {
    const now = Date.now();
    const placeholders = threadIds.map(() => "?").join(", ");
    const woken = db
      .prepare(
        `UPDATE thread_overrides SET until = ?
         WHERE thread_id IN (${placeholders})
           AND override = 'snoozed' AND until > ? AND at <= ?
         RETURNING thread_id`,
      )
      .all(now, ...threadIds, now, occurredAt) as Array<{ thread_id: string }>;
    for (const row of woken) {
      bb.realtime.publish(SETTLED_CHANNEL, { threadId: row.thread_id });
    }
  };

  // A question or failure anywhere under a snoozed root wakes it. A subagent
  // that only finished does not, though the board rolls that up as needs-you.
  const wakeForNeed = async (
    thread: { id: string; parentThreadId: string | null },
    occurredAt: number,
  ) => {
    const live = db
      .prepare(
        `SELECT 1 FROM thread_overrides WHERE override = 'snoozed' AND until > ? LIMIT 1`,
      )
      .get(Date.now());
    if (!live) return;
    const lineage = [thread.id];
    // The event already names the parent, so a failed lookup further up can
    // only cost the ancestors above it.
    let parentId = thread.parentThreadId;
    try {
      while (parentId && !lineage.includes(parentId)) {
        lineage.push(parentId);
        parentId = (await bb.sdk.threads.get({ threadId: parentId }))
          .parentThreadId;
      }
    } catch (error) {
      // Wake what we reached; a missing ancestor must not keep the thread asleep.
      bb.log.warn(
        `snooze wake: ancestor lookup failed for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    wakeSnoozed(lineage, occurredAt);
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
    const identity = await storageKeyOfEnvironment(thread.environmentId, true);
    // Remove this environment's alias so it cannot outlive the mutation.
    if (identity !== thread.environmentId) {
      db.prepare(`DELETE FROM assistant_subtitles WHERE identity = ?`).run(thread.environmentId);
    }
    const migrationPending = !db.prepare(`SELECT done FROM assistant_key_migration`).get();
    if (subtitle === "" && !migrationPending) {
      db.prepare(
        `DELETE FROM assistant_subtitles WHERE identity = ?`,
      ).run(identity);
    } else {
      // Empty subtitles persist clears while aliases await sources. Advance
      // past stored timestamps so clock skew cannot let a legacy alias win.
      const latest = db.prepare(`SELECT MAX(at) AS at FROM assistant_subtitles`).get() as { at: number | null };
      db.prepare(
        `INSERT INTO assistant_subtitles (identity, subtitle, at) VALUES (?, ?, ?)
         ON CONFLICT(identity) DO UPDATE SET
           subtitle = excluded.subtitle,
           at = excluded.at`,
      ).run(identity, subtitle, Math.max(Date.now(), latest.at ?? 0) + 1);
    }
    bb.realtime.publish(SUBTITLE_CHANNEL, { identity });
    return identity;
  };

  // Memory state lives beside each assistant's tree, outside data.db: see memory/state.ts.
  const memory = new MemoryService(bb, path.join(path.dirname(db.name), "memory"));
  bb.onDispose(() => memory.dispose());
  const memorySettings = bb.settings.define({
    rotateAtPercent: {
      type: "number",
      label: "Memory: rotate at context %",
      description: "A memory-on assistant moves to a new conversation at the end of a turn once its context is this full.",
      default: 55,
      experimental_schema: z.number().int().min(1).max(95),
    },
    summaryModel: {
      type: "string",
      label: "Memory: summary model",
      description: "The model `claude -p` writes memory summaries with, on the bb server's Claude login.",
      default: "haiku",
      experimental_schema: z.string().trim().min(1),
    },
    summaryPool: {
      type: "number",
      label: "Memory: summaries at once",
      description: "Summary calls in flight across all assistants.",
      default: 8,
      experimental_schema: z.number().int().positive(),
    },
    summaryTarget: {
      type: "number",
      label: "Memory: summary length (bytes)",
      description: "The line length a summary asks for; 512 bytes stays the limit.",
      default: 512,
      experimental_schema: z.number().int().positive(),
    },
  });
  memorySettings.onChange((next) => memory.configure(next));
  void memorySettings
    .get()
    .then((values) => {
      memory.configure(values);
      return memory.start();
    })
    .catch((error) => bb.log.warn(`memory start: ${error instanceof Error ? error.message : String(error)}`));
  bb.events.on("experimental_thread.events", ({ thread }) => memory.onEvents(thread.id));
  bb.events.on("thread.idle", ({ thread }) => memory.onIdle(thread.id));
  bb.events.on("thread.active", ({ thread }) => memory.onActive(thread.id));
  // Messages to an old thread mid-handover wait, then move to the new one.
  bb.experimental_hooks.on("message.dispatch", ({ thread }) =>
    memory.holds.has(thread.id)
      ? { action: "wait", reason: "Moving to a new conversation" }
      : { action: "proceed" },
  );

  // Any thread of an assistant names it: its home's identity.
  const memoryIdentity = async (threadId: string): Promise<string> => {
    const thread = await bb.sdk.threads.get({ threadId });
    const identity = thread.environmentId ? await storageKeyOfEnvironment(thread.environmentId, true) : "";
    if (!identity.includes(":")) throw new Error(`thread ${threadId} is not in an assistant home`);
    return identity;
  };

  const USAGE = {
    subtitle: "usage: bb assistants subtitle <thread-id> [text… | --clear]",
    memory: "usage: bb assistants memory on|off|status <thread-id> [--clear]",
    recall: "usage: bb assistants recall <id> [n] [--assistant <thread-id>]",
    date: "usage: bb assistants date <id> [--assistant <thread-id>]",
    rotate: "usage: bb assistants rotate <thread-id>",
    import: "usage: bb assistants import <thread-id> <thread-id|/path/to/file.jsonl>...",
  };
  const usageOf = (command: string) => USAGE[command as keyof typeof USAGE] ?? Object.values(USAGE).join("\n");

  const subtitleCommand = async (threadId: string, rest: string[]) => {
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
      return { exitCode: 0, stdout: `${row?.subtitle || "(none)"}\n` };
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
  };

  const memoryCommand = async (action: string, threadId: string, flag?: string) => {
    if (action === "on") return `Memory on for ${await memory.on(threadId)}, main chat ${threadId}`;
    const identity = await memoryIdentity(threadId);
    if (action === "off") {
      memory.off(identity);
      return `Memory off for ${identity}; its log, recall and date stay`;
    }
    if (action === "status") {
      if (flag === "--clear") memory.clearWarnings(identity);
      return memory.status(identity);
    }
    throw new Error(USAGE.memory);
  };

  /** recall and date: the calling thread's assistant, or `--assistant <thread-id>`. */
  const readMemory = async (args: string[], callerThreadId: string | undefined) => {
    const k = args.indexOf("--assistant");
    const threadId = k >= 0 ? args[k + 1] : callerThreadId;
    if (!threadId) throw new Error("run this inside an assistant's thread, or pass --assistant <thread-id>");
    const numbers = (k >= 0 ? [...args.slice(0, k), ...args.slice(k + 2)] : args).map(Number);
    return { identity: await memoryIdentity(threadId), numbers };
  };

  const rotateCommand = async (threadId: string) => {
    const identity = await memoryIdentity(threadId);
    const state = memory.state(identity);
    if (!state.on) throw new Error(`memory is off for ${identity}`);
    if (state.main !== threadId) throw new Error(`${threadId} is not the main chat; it is ${state.main}`);
    const result = await handover(memory, { identity, oldThreadId: threadId });
    return `Rotated to ${result.newThreadId}${result.warning ? `\nwarning: ${result.warning}` : ""}`;
  };

  bb.cli.register({
    name: "assistants",
    summary: "Assistant sidebar helpers",
    commands: [
      { name: "subtitle", summary: "Show, set, or clear an assistant's sidebar subtitle", usage: USAGE.subtitle },
      { name: "memory", summary: "Turn an assistant's endless conversation on or off, or show its state", usage: USAGE.memory },
      { name: "recall", summary: "Open a line of this assistant's memory view; n = 1 gives the message whole", usage: USAGE.recall },
      { name: "date", summary: "The date and time of a message in this assistant's memory", usage: USAGE.date },
      { name: "rotate", summary: "Move a memory-on assistant to a new conversation now", usage: USAGE.rotate },
      { name: "import", summary: "Seed an assistant's memory with past threads or a JSONL file, before memory is on", usage: USAGE.import },
    ],
    run: async (argv, ctx) => {
      const [command, ...args] = argv;
      try {
        switch (command) {
          case "subtitle":
            if (!args[0]) break;
            return await subtitleCommand(args[0], args.slice(1));
          case "memory":
            if (!args[0] || !args[1]) break;
            return { exitCode: 0, stdout: `${await memoryCommand(args[0], args[1], args[2])}\n` };
          case "recall": {
            const { identity, numbers: [id, n = 1] } = await readMemory(args, ctx?.threadId);
            if (id === undefined) break;
            return { exitCode: 0, stdout: `${memory.recall(identity, id, n)}\n` };
          }
          case "date": {
            const { identity, numbers: [id] } = await readMemory(args, ctx?.threadId);
            if (id === undefined) break;
            return { exitCode: 0, stdout: `${memory.date(identity, id)}\n` };
          }
          case "rotate":
            if (!args[0]) break;
            return { exitCode: 0, stdout: `${await rotateCommand(args[0])}\n` };
          case "import": {
            if (args.length < 2) break;
            memory.startImport(await memoryIdentity(args[0]), args.slice(1));
            return { exitCode: 0, stdout: `Import started; see bb assistants memory status ${args[0]}\n` };
          }
        }
        return { exitCode: 1, stderr: `${usageOf(command)}\n` };
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
          .prepare(`SELECT thread_id, override, at, until FROM thread_overrides`)
          .all() as OverrideDbRow[]
      ).map((row) =>
        row.override === "snoozed"
          ? { threadId: row.thread_id, override: row.override, at: row.at, until: row.until }
          : { threadId: row.thread_id, override: row.override, at: row.at },
      );
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
    async snooze({ threadId, until }) {
      if (until <= Date.now()) throw new Error("Snooze time is in the past");
      write(threadId, "snoozed", until);
      return { ok: true };
    },
    async wake({ threadId }) {
      wakeSnoozed([threadId], Date.now());
      return { ok: true };
    },
    // Opening a woken thread hands it back to the ordinary rules as "active",
    // which restarts the quiet clock: a week-long snooze must not auto-settle
    // the moment it is opened. Keyed on the `until` the client saw, so a late
    // acknowledgement cannot undo a newer snooze or settle. No check against
    // our own clock: a browser a few seconds ahead would be refused forever.
    async acknowledgeWake({ threadId, until }) {
      const now = Date.now();
      const changed = db
        .prepare(
          `UPDATE thread_overrides SET override = 'active', at = ?, until = NULL
           WHERE thread_id = ? AND override = 'snoozed' AND until = ?`,
        )
        .run(now, threadId, until).changes;
      if (changed > 0) bb.realtime.publish(SETTLED_CHANNEL, { threadId });
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
        memory: memory.isOn(context.identity),
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
    // Final non-home answers keep their own id; unresolved reads reject so
    // the client cannot enable dragging with temporary fallback keys.
    async assistantIdentities({ environmentIds }) {
      const rows = await Promise.all(
        [...new Set(environmentIds)].map(async (environmentId) => ({
          environmentId,
          identity: await storageKeyOfEnvironment(environmentId, true),
        })),
      );
      return { rows };
    },
    async listAssistantSubtitles() {
      const rows = (
        db
          .prepare(`SELECT identity, subtitle FROM assistant_subtitles WHERE subtitle != ''`)
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
    // Resolve environment-id inputs before touching the saved order.
    // Ids the fleet no longer has just stop matching and the next write
    // clears them.
    async setAssistantOrder({ identities }) {
      const keys = await Promise.all(identities.map((identity) =>
        identity.includes(":")
          ? identity
          : storageKeyOfEnvironment(identity, true),
      ));
      db.prepare(`DELETE FROM assistant_order`).run();
      const insert = db.prepare(
        `INSERT INTO assistant_order (identity, rank) VALUES (?, ?)`,
      );
      [...new Set(keys)].forEach((identity, rank) => {
        insert.run(identity, rank);
      });
      bb.realtime.publish(ASSISTANT_ORDER_CHANNEL, {});
      return { ids: readAssistantOrder() };
    },
    async createReplacementThread({ replaceThreadId, request, destinationHostId, homePath }) {
      const context = await assistantConversationContext(bb, replaceThreadId);
      if (request.projectId !== context.thread.projectId)
        throw new Error("Keep the assistants project selected");
      if (memory.isOn(context.identity)) {
        // The handover spawns at once and holds the old thread meanwhile; a later send has no place in it.
        if (request.sendAt !== undefined) throw new Error("Scheduled sends are not supported while memory is on");
        return handover(memory, {
          identity: context.identity,
          oldThreadId: replaceThreadId,
          composer: {
            destination: { hostId: destinationHostId, homePath },
            execution: {
              providerId: request.providerId,
              model: request.model,
              reasoningLevel: request.reasoningLevel,
              permissionMode: request.permissionMode,
              serviceTier: request.serviceTier,
              executionInputSources: request.executionInputSources,
            },
            visible: request.input as Place["visible"],
          },
        });
      }
      await context.validate(destinationHostId, homePath);
      // Listed before spawning, so an unreachable automations plugin refuses
      // the restart instead of stranding jobs on an archived thread.
      const automations = await targetingAutomationsOf(bb, replaceThreadId);
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
      const stuck = await repointAutomations(bb, automations, fresh.id);
      // Runs against an archived thread are skipped, so the old one stays
      // live until every automation follows the new one.
      if (stuck.length > 0)
        return { newThreadId: fresh.id, warning: `Old conversation kept, these automations still target it: ${stuck.join("; ")}` };
      try {
        await bb.sdk.threads.archive({ threadId: replaceThreadId });
      } catch (error) {
        return { newThreadId: fresh.id, warning: `Old conversation could not be archived: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { newThreadId: fresh.id };
    },
    async assistantMemory() {
      return { rows: memory.rows() };
    },
    async pastAssistantThreads({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) return { rows: [] };
      const identity = await storageKeyOfEnvironment(thread.environmentId, true);
      const archived = (await bb.sdk.threads.list({ archived: true, projectId: thread.projectId, hasParent: false }))
        .filter((past) => past.environmentId && past.archivedAt != null);
      // One lookup per home, not per thread: a busy assistant has dozens.
      const environmentIds = [...new Set(archived.map((past) => past.environmentId!))];
      const keys = new Map(await Promise.all(
        environmentIds.map(async (id) => [id, await storageKeyOfEnvironment(id)] as const),
      ));
      return {
        rows: archived
          .filter((past) => keys.get(past.environmentId!) === identity)
          .sort((a, b) => b.archivedAt! - a.archivedAt!)
          .map((past) => ({ id: past.id, createdAt: past.createdAt, archivedAt: past.archivedAt! })),
      };
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

  // Our own needs-you signals: a pending request or a failure. Both events
  // fire only for a new one, so a request already open when the user
  // snoozed never wakes the thread.
  bb.events.on("interaction.pending", ({ thread, interaction }) =>
    wakeForNeed(thread, interaction.createdAt),
  );
  bb.events.on("thread.failed", ({ thread }) =>
    wakeForNeed(thread, thread.updatedAt),
  );
}
