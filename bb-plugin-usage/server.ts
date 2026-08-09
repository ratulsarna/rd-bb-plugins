import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { createUsageService, fetchUsageLimits } from "./lib/usage";

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
        claudeCode: z
          .object({
            id: z.literal("claudeCode"),
            name: z.literal("Claude Code"),
            ...providerFields,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  getUsage: {
    input: z.object({ refresh: z.boolean().optional() }).strict(),
    output: usageOutputSchema,
  },
});

export default function plugin(bb: BbPluginApi) {
  const usage = createUsageService({
    fetchUsage: () => fetchUsageLimits((args) => bb.sdk.system.usageLimits(args)),
    publishUsageUpdated: ({ fetchedAt }) => {
      bb.realtime.publish("usage-updated", { fetchedAt });
    },
  });

  bb.rpc.register(rpcContract, {
    getUsage: (input) => usage.getUsage(input),
  });
}
