import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CARD_ORDER_CHANNEL, MAX_CARD_ORDER } from "./lib/card-order";
import { createClaudeCredentialRecovery } from "./lib/claude-recovery";
import { createUsageService } from "./lib/usage";
import { fetchFleetUsage } from "./lib/fleet-usage";
import { fetchZaiUsage } from "./lib/zai";

const paceSchema = z
  .object({
    kind: z.enum(["deficit", "reserve", "on_pace"]),
    percentage: z.number().int().nonnegative(),
  })
  .strict();

const windowSchema = z
  .object({
    label: z.string(),
    remainingPercent: z.number().int().min(0).max(100),
    resetsAt: z.string().datetime().nullable(),
    pace: paceSchema.nullable(),
  })
  .strict();

const providerFields = {
  status: z.enum([
    "ok",
    "not_installed",
    "unauthenticated",
    "expired",
    "error",
    "offline",
  ]),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
  windows: z.array(windowSchema),
};

const usageOutputSchema = z
  .object({
    fetchedAt: z.string().datetime(),
    providers: z
      .object({
        codex: z
          .object({
            id: z.literal("codex"),
            name: z.literal("Codex"),
            ...providerFields,
          })
          .strict(),
        claudeCode: z.array(
          z
            .object({
              id: z.literal("claudeCode"),
              name: z.literal("Claude Code"),
              accountId: z.string(),
              machines: z.array(
                z
                  .object({
                    id: z.string(),
                    name: z.string(),
                    status: providerFields.status,
                  })
                  .strict(),
              ),
              ...providerFields,
            })
            .strict(),
        ),
        zai: z
          .object({
            id: z.literal("zai"),
            name: z.literal("Z.ai"),
            ...providerFields,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const cardOrderSchema = z
  .object({ order: z.array(z.string().min(1)).max(MAX_CARD_ORDER) })
  .strict();

const CARD_ORDER_KEY = "card-order";

export const rpcContract = defineRpcContract({
  getUsage: {
    input: z.object({ refresh: z.boolean().optional() }).strict(),
    output: usageOutputSchema,
  },
  getCardOrder: { input: z.object({}).strict(), output: cardOrderSchema },
  setCardOrder: { input: cardOrderSchema, output: cardOrderSchema },
});

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    zaiApiKey: {
      type: "string",
      label: "Z.ai API key",
      description:
        "Coding plan API key from z.ai/manage-apikey/apikey. Sent only to api.z.ai to read quota.",
      secret: true,
    },
  });
  const claudeRecovery = createClaudeCredentialRecovery();
  const usage = createUsageService({
    // bb has no Z.ai usage API, so the plugin asks Z.ai directly.
    fetchUsage: async () => {
      const [limits, zai] = await Promise.all([
        fetchFleetUsage({
          listHosts: () => bb.sdk.hosts.list(),
          getPrimaryHostId: async () =>
            (await bb.sdk.system.config()).primaryHostId,
          usageLimits: (args) => bb.sdk.system.usageLimits(args),
        }),
        settings.get().then(({ zaiApiKey }) => fetchZaiUsage(zaiApiKey)),
      ]);
      return { ...limits, providers: { ...limits.providers, zai } };
    },
    recoverClaudeCredentials: claudeRecovery.recover,
    publishUsageUpdated: ({ fetchedAt }) => {
      bb.realtime.publish("usage-updated", { fetchedAt });
    },
  });

  bb.onDispose(claudeRecovery.dispose);

  bb.rpc.register(rpcContract, {
    getUsage: (input) => usage.getUsage(input),
    async getCardOrder() {
      return { order: (await bb.storage.kv.get<string[]>(CARD_ORDER_KEY)) ?? [] };
    },
    async setCardOrder({ order }) {
      await bb.storage.kv.set(CARD_ORDER_KEY, order);
      bb.realtime.publish(CARD_ORDER_CHANNEL, {});
      return { order };
    },
  });
}
