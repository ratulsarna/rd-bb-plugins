import { z } from "zod";
import { parseAgentModels } from "@ratulsarna/agent-models/schema";
import type { AgentModels, ModelSelection } from "@ratulsarna/agent-models/schema";

export const REVIEWER_ROLES = [["first", "Reviewer 1"], ["second", "Reviewer 2"], ["shape", "Shape"]] as const;
export const SUBAGENT_ROLES = [["oracle", "Oracle"], ["complex", "Complex"], ["workhorse", "Workhorse"], ["qa", "QA & computer use"]] as const;

const selectionSchema = z.object({ providerId: z.string(), model: z.string(), reasoningLevel: z.string(), serviceTier: z.enum(["default", "fast"]).optional() }).strict();
export const agentModelsSchema = z.object({
  review: z.object({ first: selectionSchema, second: selectionSchema, shape: selectionSchema }).strict(),
  subagents: z.object({ oracle: selectionSchema, complex: selectionSchema, workhorse: selectionSchema, qa: selectionSchema }).strict(),
}).strict().superRefine((value, context) => {
  try { parseAgentModels(value); }
  catch (error) { context.addIssue({ code: "custom", message: String(error) }); }
});

export const agentModelSettingsSchema = z.object({
  models: agentModelsSchema,
  revision: z.string(),
  path: z.string(),
  source: z.enum(["defaults", "file"]),
}).strict();

function reasoning({ reasoningLevel, serviceTier }: ModelSelection) {
  return serviceTier === "fast" ? `${reasoningLevel}, fast tier` : reasoningLevel;
}

// The "when to use" text for each role belongs to the user's own instructions; this table only names the models.
export function subagentInstructions(models: AgentModels["subagents"]) {
  return ["## Subagent models", "",
    "Use these when you spawn a bb child thread for a role. Pick the role by task shape as your user instructions describe.", "",
    "| Role | Harness | Model | Reasoning |", "|---|---|---|---|",
    ...SUBAGENT_ROLES.map(([role, label]) => `| ${label} | ${models[role].providerId} | ${models[role].model} | ${reasoning(models[role])} |`),
  ].join("\n");
}
