// The Bots section's backend, ported from the inbox-sidebar plugin.
//
// Split by ownership: the stateless halves (seeds, avatars, replacement
// threads) talk to bb.sdk directly and live here verbatim; the two stateful
// halves (subtitles, drag order) stay owned by the inbox-sidebar plugin's
// database and are reached by cross-plugin RPC, so both sidebars read and
// write one source of truth. If that plugin is absent, reads degrade to
// empty (initials, activity order) and writes surface their error.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { botsRpcContract } from "./contract";
import { BOTS_ASSISTANT_ORDER_CHANNEL, BOTS_SUBTITLES_CHANNEL } from "./channels";

/** The plugin that owns assistant subtitles and the stored Bots order. */
const INBOX_SIDEBAR_PLUGIN_ID = "inbox-sidebar";

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

// A directory is an assistant home when it carries its own identity file.
const isAssistantHome = async (
  bb: BbPluginApi,
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
  bb: BbPluginApi,
  hostId: string,
  environmentPath: string,
): Promise<Array<{ name: string; path: string }>> => {
  try {
    const here = await bb.sdk.hosts.directory({
      hostId,
      path: environmentPath,
    });
    const root = (await isAssistantHome(bb, hostId, environmentPath))
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
      dirs.map((dir) => isAssistantHome(bb, hostId, dir.path)),
    );
    return dirs
      .filter((_, index) => flags[index])
      .map(({ name, path }) => ({ name, path }));
  } catch {
    return [];
  }
};

const subtitlesOutput = z.object({
  rows: z.array(
    z.object({ environmentId: z.string(), subtitle: z.string() }),
  ),
});
const okOutput = z.object({ ok: z.boolean() });
const idsOutput = z.object({ ids: z.array(z.string()) });

export function registerBots(bb: BbPluginApi): void {
  bb.rpc.register(botsRpcContract, {
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
        ? await listAssistantHomes(bb, env.hostId, env.path)
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
    // Stateful halves, proxied to the plugin that owns the tables.
    async listAssistantSubtitles() {
      try {
        return await bb.sdk.plugins.callRpc({
          pluginId: INBOX_SIDEBAR_PLUGIN_ID,
          method: "listAssistantSubtitles",
          input: {},
          outputSchema: subtitlesOutput,
        });
      } catch (error) {
        bb.log.warn(
          `Bots subtitles unavailable (${INBOX_SIDEBAR_PLUGIN_ID} not running?): ${error instanceof Error ? error.message : String(error)}`,
        );
        return { rows: [] };
      }
    },
    async setAssistantSubtitle({ threadId, subtitle }) {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: INBOX_SIDEBAR_PLUGIN_ID,
        method: "setAssistantSubtitle",
        input: { threadId, subtitle },
        outputSchema: okOutput,
      });
      bb.realtime.publish(BOTS_SUBTITLES_CHANNEL, { threadId });
      return result;
    },
    async assistantOrder() {
      try {
        return await bb.sdk.plugins.callRpc({
          pluginId: INBOX_SIDEBAR_PLUGIN_ID,
          method: "assistantOrder",
          input: {},
          outputSchema: idsOutput,
        });
      } catch (error) {
        bb.log.warn(
          `Bots order unavailable (${INBOX_SIDEBAR_PLUGIN_ID} not running?): ${error instanceof Error ? error.message : String(error)}`,
        );
        return { ids: [] };
      }
    },
    async setAssistantOrder({ environmentIds }) {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: INBOX_SIDEBAR_PLUGIN_ID,
        method: "setAssistantOrder",
        input: { environmentIds },
        outputSchema: idsOutput,
      });
      bb.realtime.publish(BOTS_ASSISTANT_ORDER_CHANNEL, {});
      return result;
    },
  });
}
