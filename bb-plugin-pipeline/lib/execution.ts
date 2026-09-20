import type { PluginBbSdk } from "@get-bb/plugin-sdk";
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
  const leadProviderId = settings.leadProviderId?.trim() || undefined;
  const leadModel = settings.leadModel?.trim() || undefined;
  const hasSavedLead =
    leadProviderId !== undefined ||
    leadModel !== undefined ||
    settings.leadReasoningLevel !== undefined ||
    settings.leadServiceTier !== undefined;
  const leadServiceTier = hasSavedLead
    ? settings.leadServiceTier
    : settings.serviceTier;

  return {
    intake,
    lead: executionSelectionSchema.parse({
      providerId: leadProviderId ?? intake.providerId,
      model: leadModel ?? intake.model,
      reasoningLevel: settings.leadReasoningLevel ?? intake.reasoningLevel,
      ...(leadServiceTier === undefined ? {} : { serviceTier: leadServiceTier }),
    }),
  };
}

type ExecutionRole = keyof ExecutionDefaults;

function machineLabel(machine: { id: string; name: string }): string {
  return `machine "${machine.name}" (${machine.id})`;
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function validateExecutionSelections(
  sdk: PluginBbSdk,
  machine: { id: string; name: string },
  selections: ExecutionDefaults,
): Promise<void> {
  let providers: Awaited<ReturnType<PluginBbSdk["providers"]["list"]>>;
  try {
    providers = await sdk.providers.list({ hostId: machine.id });
  } catch (cause) {
    throw new Error(
      `could not load providers for ${machineLabel(machine)}: ${causeMessage(cause)}`,
    );
  }

  const roles = Object.entries(selections) as [ExecutionRole, ExecutionSelection][];
  const selectedProviders = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  for (const [role, selection] of roles) {
    const provider = selectedProviders.get(selection.providerId);
    if (provider === undefined) {
      throw new Error(
        `${role} provider "${selection.providerId}" is not installed on ${machineLabel(machine)}`,
      );
    }
    if (!provider.available) {
      throw new Error(
        `${role} provider "${selection.providerId}" is unavailable on ${machineLabel(machine)}`,
      );
    }
  }

  const catalogs = new Map<
    string,
    Awaited<ReturnType<PluginBbSdk["providers"]["models"]>>
  >();

  for (const [role, selection] of roles) {
    let catalog = catalogs.get(selection.providerId);
    if (catalog === undefined) {
      try {
        catalog = await sdk.providers.models({
          hostId: machine.id,
          providerId: selection.providerId,
        });
        catalogs.set(selection.providerId, catalog);
      } catch (cause) {
        throw new Error(
          `could not load ${role} models for provider "${selection.providerId}" on ${machineLabel(machine)}: ${causeMessage(cause)}`,
        );
      }
    }
    if (catalog.modelLoadError !== null) {
      throw new Error(
        `could not load ${role} models for provider "${selection.providerId}" on ${machineLabel(machine)} (${catalog.modelLoadError.code})`,
      );
    }

    const model = [...catalog.models, ...catalog.selectedOnlyModels].find(
      (candidate) =>
        candidate.model === selection.model || candidate.id === selection.model,
    );
    if (model === undefined) {
      throw new Error(
        `${role} model "${selection.model}" is unavailable for provider "${selection.providerId}" on ${machineLabel(machine)}`,
      );
    }
    if (
      !model.supportedReasoningEfforts.some(
        (candidate) => candidate.reasoningEffort === selection.reasoningLevel,
      )
    ) {
      throw new Error(
        `${role} reasoning "${selection.reasoningLevel}" is unsupported by model "${selection.model}" on ${machineLabel(machine)}`,
      );
    }

    const provider = selectedProviders.get(selection.providerId)!;
    if (
      selection.serviceTier !== undefined &&
      !provider.capabilities.supportsServiceTier
    ) {
      throw new Error(
        `${role} service tier "${selection.serviceTier}" is unsupported by provider "${selection.providerId}" on ${machineLabel(machine)}`,
      );
    }
  }
}
