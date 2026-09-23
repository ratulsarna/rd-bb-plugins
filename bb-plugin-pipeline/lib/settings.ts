import type { PluginSettingDescriptors, PluginSettingsValues } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseThreshold } from "./jev";
import { executionDefaults, executionSelectionSchema, REASONING_LEVELS } from "./execution";

export const SETTINGS = {
  providerId: {
    type: "string",
    label: "Intake provider",
    default: "claude-code",
    experimental_schema: z.string().refine((value) => value.trim() !== "", "Choose an intake provider"),
  },
  model: {
    type: "string",
    label: "Intake model",
    default: "claude-fable-5-1",
    experimental_schema: z.string().refine((value) => value.trim() !== "", "Choose an intake model"),
  },
  reasoningLevel: {
    type: "select",
    label: "Intake reasoning",
    options: [...REASONING_LEVELS],
    default: "high",
  },
  serviceTier: {
    type: "select",
    label: "Intake service tier",
    options: ["default", "fast"],
  },
  leadProviderId: { type: "string", label: "Lead provider" },
  leadModel: { type: "string", label: "Lead model" },
  leadReasoningLevel: {
    type: "select",
    label: "Lead reasoning",
    options: [...REASONING_LEVELS],
  },
  leadServiceTier: {
    type: "select",
    label: "Lead service tier",
    options: ["default", "fast"],
  },
  permissionMode: {
    type: "select",
    label: "Permission",
    options: ["accept-edits", "auto", "full"],
    default: "full",
  },
  reviewRequestComment: {
    type: "string",
    label: "Review request comment (empty for automatic reviews)",
    default: "@codex review",
  },
  jevApiKey: {
    type: "string",
    label: "TypeSafe API key",
    secret: true,
  },
  jevThreshold: {
    type: "string",
    label: "Jev confidence threshold (0.5..1)",
    default: "0.7",
    experimental_schema: z.string().refine((value) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0.5 && Number(value) <= 1, "Enter a confidence threshold from 0.5 to 1"),
  },
  rememberExecution: { type: "boolean", label: "Remember last task's execution choices", default: true },
  taskLimit: { type: "number", label: "Concurrent tasks per project and machine", default: 2, experimental_schema: z.number().int().min(1).max(32) },
  autoReviewFollowup: { type: "boolean", label: "Send review findings to the lead automatically", default: true },
  notificationsEnabled: { type: "boolean", label: "Pipeline notifications", default: true },
  notifyQuestions: { type: "boolean", label: "Questions and approvals", default: true },
  notifyFailures: { type: "boolean", label: "Failures", default: true },
  notifyReview: { type: "boolean", label: "Review and merge decisions", default: true },
} satisfies PluginSettingDescriptors;

export const pipelineSettingsSchema = z.object({
  intake: executionSelectionSchema,
  lead: executionSelectionSchema,
  rememberExecution: z.boolean(),
  taskLimit: z.number().int().min(1).max(32),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
  reviewRequestComment: z.string(),
  autoReviewFollowup: z.boolean(),
  notificationsEnabled: z.boolean(),
  notifyQuestions: z.boolean(),
  notifyFailures: z.boolean(),
  notifyReview: z.boolean(),
  jevThreshold: z.number().min(0.5).max(1),
}).strict();
export type PipelineSettingsValues = z.infer<typeof pipelineSettingsSchema>;
export const settingsViewSchema = z.object({
  values: pipelineSettingsSchema,
  jevApiKeyConfigured: z.boolean(),
}).strict();
export const settingsUpdateSchema = z.object({
  values: pipelineSettingsSchema.partial(),
  jevApiKey: z.string().trim().min(1).max(4_096).nullable().optional(),
}).strict();
export const integrationStatusSchema = z.object({
  github: z.object({ available: z.boolean(), detail: z.string() }).strict(),
  jev: z.object({ configured: z.boolean() }).strict(),
  notify: z.object({ available: z.boolean(), detail: z.string() }).strict(),
}).strict();

type StoredSettings = PluginSettingsValues<typeof SETTINGS>;
export function settingsView(settings: StoredSettings): z.infer<typeof settingsViewSchema> {
  return {
    values: pipelineSettingsSchema.parse({
      ...executionDefaults(settings),
      rememberExecution: settings.rememberExecution,
      taskLimit: settings.taskLimit,
      permissionMode: settings.permissionMode,
      reviewRequestComment: settings.reviewRequestComment,
      autoReviewFollowup: settings.autoReviewFollowup,
      notificationsEnabled: settings.notificationsEnabled,
      notifyQuestions: settings.notifyQuestions,
      notifyFailures: settings.notifyFailures,
      notifyReview: settings.notifyReview,
      jevThreshold: parseThreshold(settings.jevThreshold),
    }),
    jevApiKeyConfigured: Boolean(settings.jevApiKey?.trim()),
  };
}

export function settingsPatch(input: z.infer<typeof settingsUpdateSchema>, current: StoredSettings) {
  const { intake, lead: requestedLead, jevThreshold, ...values } = input.values;
  // Pin an inherited Lead before an independent Intake edit changes its inputs.
  const lead = requestedLead ?? (intake !== undefined &&
    (!current.leadProviderId?.trim() || !current.leadModel?.trim() || current.leadReasoningLevel === undefined)
    ? executionDefaults(current).lead : undefined);
  return {
    ...values,
    ...(intake === undefined ? {} : {
      providerId: intake.providerId, model: intake.model, reasoningLevel: intake.reasoningLevel,
      serviceTier: intake.serviceTier ?? null,
    }),
    ...(lead === undefined ? {} : {
      leadProviderId: lead.providerId, leadModel: lead.model, leadReasoningLevel: lead.reasoningLevel,
      leadServiceTier: lead.serviceTier ?? null,
    }),
    ...(jevThreshold === undefined ? {} : { jevThreshold: String(jevThreshold) }),
    ...(input.jevApiKey === undefined ? {} : { jevApiKey: input.jevApiKey }),
  };
}
