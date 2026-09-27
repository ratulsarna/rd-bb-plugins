import { z } from "zod";
import { parseReviewModels } from "@ratulsarna/agent-models/schema";

const reviewerSchema = z.object({ model: z.string(), reasoningLevel: z.string() }).strict();
export const reviewModelsSchema = z.object({
  codex: reviewerSchema,
  glm: reviewerSchema,
}).strict().superRefine((value, context) => {
  try { parseReviewModels(value); }
  catch (error) { context.addIssue({ code: "custom", message: String(error) }); }
});

export const reviewModelSettingsSchema = z.object({
  models: reviewModelsSchema,
  revision: z.string(),
  path: z.string(),
  source: z.enum(["defaults", "file"]),
}).strict();
