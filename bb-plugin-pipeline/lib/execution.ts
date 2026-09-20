import type { ReasoningLevel } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const satisfies readonly ReasoningLevel[];

export interface ExecutionSelection {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier?: "fast" | "default";
}

export const executionSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    model: z.string().trim().min(1),
    reasoningLevel: z.enum(REASONING_LEVELS),
    serviceTier: z.enum(["fast", "default"]).optional(),
  })
  .strict() satisfies z.ZodType<ExecutionSelection>;

export interface ExecutionDefaults {
  intake: ExecutionSelection;
  lead: ExecutionSelection;
}

export interface ExecutionSettings {
  providerId: string;
  model: string;
  reasoningLevel: string;
  serviceTier?: string;
  leadProviderId?: string;
  leadModel?: string;
  leadReasoningLevel?: string;
  leadServiceTier?: string;
}

export function executionDefaults(settings: ExecutionSettings): ExecutionDefaults {
  const intake = executionSelectionSchema.parse({
    providerId: settings.providerId,
    model: settings.model,
    reasoningLevel: settings.reasoningLevel,
    ...(settings.serviceTier === undefined
      ? {}
      : { serviceTier: settings.serviceTier }),
  });
  const hasSavedLead =
    settings.leadProviderId !== undefined ||
    settings.leadModel !== undefined ||
    settings.leadReasoningLevel !== undefined ||
    settings.leadServiceTier !== undefined;
  const leadServiceTier = hasSavedLead
    ? settings.leadServiceTier
    : settings.serviceTier;

  return {
    intake,
    lead: executionSelectionSchema.parse({
      providerId: settings.leadProviderId ?? intake.providerId,
      model: settings.leadModel ?? intake.model,
      reasoningLevel: settings.leadReasoningLevel ?? intake.reasoningLevel,
      ...(leadServiceTier === undefined ? {} : { serviceTier: leadServiceTier }),
    }),
  };
}
