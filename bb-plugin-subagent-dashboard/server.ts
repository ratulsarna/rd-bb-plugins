import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const dashboardInput = z
  .object({
    projectId: z.string().nullable(),
    parentThreadId: z.string().nullable(),
  })
  .strict();

const subagentSchema = z
  .object({
    id: z.string(),
    parentThreadId: z.string(),
    projectId: z.string(),
    providerId: z.string(),
    title: z.string(),
    status: z.string(),
    environmentName: z.string().nullable(),
    branchName: z.string().nullable(),
    visibility: z.enum(["visible", "hidden"]),
    updatedAt: z.number(),
    hasPendingInteraction: z.boolean(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  dashboard: {
    input: dashboardInput,
    output: z
      .object({
        subagents: z.array(subagentSchema),
        counts: z
          .object({
            total: z.number().int(),
            active: z.number().int(),
            idle: z.number().int(),
            attention: z.number().int(),
          })
          .strict(),
      })
      .strict(),
  },
  stopSubagent: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  messageSubagent: {
    input: z
      .object({
        threadId: z.string(),
        message: z.string().trim().min(1),
        mode: z.enum(["steer", "queue"]),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export default function plugin(bb: BbPluginApi) {
  async function requireSubagent(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.parentThreadId) {
      throw new Error("This thread is not a subagent.");
    }
    return thread;
  }

  bb.rpc.register(rpcContract, {
    async dashboard({ projectId, parentThreadId }) {
      const threads = await bb.sdk.threads.list({
        ...(projectId ? { projectId } : {}),
        ...(parentThreadId ? { parentThreadId } : { hasParent: true }),
        includeHidden: true,
        limit: 200,
      });

      const subagents = threads
        .filter((thread) => thread.parentThreadId !== null)
        .map((thread) => ({
          id: thread.id,
          parentThreadId: thread.parentThreadId!,
          projectId: thread.projectId,
          providerId: thread.providerId,
          title: thread.title ?? thread.titleFallback ?? "Untitled subagent",
          status: thread.runtime.displayStatus,
          environmentName: thread.environmentName,
          branchName: thread.environmentBranchName,
          visibility: thread.visibility,
          updatedAt: thread.updatedAt,
          hasPendingInteraction: thread.hasPendingInteraction,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      const isActive = (status: string) =>
        ["active", "starting", "provisioning", "stopping"].includes(status);
      const needsAttention = (status: string) =>
        ["error", "host-reconnecting", "waiting-for-host"].includes(status);

      return {
        subagents,
        counts: {
          total: subagents.length,
          active: subagents.filter((agent) => isActive(agent.status)).length,
          idle: subagents.filter((agent) => agent.status === "idle").length,
          attention: subagents.filter(
            (agent) => agent.hasPendingInteraction || needsAttention(agent.status),
          ).length,
        },
      };
    },

    async stopSubagent({ threadId }) {
      await requireSubagent(threadId);
      await bb.sdk.threads.stop({ threadId });
      return { ok: true as const };
    },

    async messageSubagent({ threadId, message, mode }) {
      await requireSubagent(threadId);
      await bb.sdk.threads.send({
        threadId,
        mode: mode === "steer" ? "steer" : "queue-if-active",
        input: [{ type: "text", text: message, mentions: [] }],
      });
      return { ok: true as const };
    },
  });

  const publishThreadChange = (thread: {
    id: string;
    projectId: string;
    parentThreadId: string | null;
  }) => {
    bb.realtime.publish("threads-changed", {
      threadId: thread.id,
      projectId: thread.projectId,
      parentThreadId: thread.parentThreadId,
    });
  };

  bb.events.on("thread.created", ({ thread }) => publishThreadChange(thread));
  bb.events.on("thread.active", ({ thread }) => publishThreadChange(thread));
  bb.events.on("thread.idle", ({ thread }) => publishThreadChange(thread));
  bb.events.on("thread.failed", ({ thread }) => publishThreadChange(thread));
  bb.events.on("thread.archived", ({ thread }) => publishThreadChange(thread));
  bb.events.on("thread.deleted", ({ thread }) => publishThreadChange(thread));

  bb.log.info("Subagent Dashboard loaded");
}
