// Assistants: identity keys, subtitles, the fleet order, conversation moves
// and memory. The inbox board under Bots (settles, snoozes, pins, projects)
// comes from inbox-core and shares this plugin's database below.
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { INBOX_MIGRATIONS, registerInbox } from "inbox-core/server";
// Relative on purpose: a path install loads server.ts directly, where the
// bundler's "@/" alias does not exist.
import { createIdentityResolver } from "./lib/assistant-identity";
import {
  assistantConversationContext,
  assistantDestinationSchema,
  assistantMachineSchema,
  repointAutomations,
  targetingAutomationsOf,
} from "./lib/assistant-conversation";
import { handover, type Place } from "./memory/handover";
import { MEMORY_CHANNEL, MemoryService } from "./memory/service";
import { SUMMARY_RUNNERS } from "./memory/summarize";

const threadIdInput = z.object({ threadId: z.string().trim().min(1) });

export const assistantRpcContract = defineRpcContract({
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

/** Realtime channel the assistant list re-reads subtitles on. */
export const SUBTITLE_CHANNEL = "assistant-subtitles";

/** Realtime channel the Bots section re-reads its row order on. */
export const ASSISTANT_ORDER_CHANNEL = "assistant-order";

export { MEMORY_CHANNEL };

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    INBOX_MIGRATIONS.createThreadOverrides,
    `CREATE TABLE assistant_subtitles (
       identity TEXT PRIMARY KEY,
       subtitle TEXT NOT NULL
     )`,
    `CREATE TABLE assistant_order (
       identity TEXT PRIMARY KEY,
       rank     INTEGER NOT NULL
     )`,
  ]);
  registerInbox(bb, db);

  const identityOfEnvironment = createIdentityResolver(bb);

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

  const readAssistantOrder = (): string[] =>
    (
      db
        .prepare(
          `SELECT identity FROM assistant_order ORDER BY rank`,
        )
        .all() as Array<{ identity: string }>
    ).map((row) => row.identity);

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
    if (subtitle === "") {
      db.prepare(
        `DELETE FROM assistant_subtitles WHERE identity = ?`,
      ).run(identity);
    } else {
      db.prepare(
        `INSERT INTO assistant_subtitles (identity, subtitle) VALUES (?, ?)
         ON CONFLICT(identity) DO UPDATE SET subtitle = excluded.subtitle`,
      ).run(identity, subtitle);
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
    summaryRunner: {
      type: "select",
      label: "Memory: summary runner",
      description: "The CLI on the bb server that writes memory summaries: `claude` on its Claude login (never an API key), or `pi` with any model pi knows.",
      options: SUMMARY_RUNNERS,
      default: "claude",
    },
    summaryModel: {
      type: "string",
      label: "Memory: summary model",
      description: "The model the runner writes summaries with: for claude, e.g. `haiku`; for pi, `provider/model`, e.g. `zai/glm-5.3-flash`.",
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
    summariesPaused: {
      type: "boolean",
      label: "Memory: pause summaries",
      description: "Start no new summary calls; those running finish. Logging and recall go on; a rotation waits for summaries to catch up.",
      default: false,
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
  bb.events.on("thread.archived", ({ thread }) => memory.onGone(thread.id, "archived"));
  bb.events.on("thread.deleted", ({ thread }) => memory.onGone(thread.id, "deleted"));
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

  bb.rpc.register(assistantRpcContract, {
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
}
