import type {
  Catalog,
  Favorite,
  FavoriteSeed,
  PickerHost,
  PickerModel,
  PickerProject,
  PickerProvider,
  ProjectKind,
  ReasoningLevel,
  ServiceTier,
} from "./schema";

export function newFavoriteId(now = Date.now()): string {
  return `fav_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeFavoriteName(name: string | null | undefined): string {
  return name?.trim() ?? "";
}

export function favoriteOpenLabel(favorite: {
  name: string;
  projectName: string;
  providerName: string;
  modelName: string;
}): string {
  const name = normalizeFavoriteName(favorite.name);
  return name
    ? `Open ${name}`
    : `Open ${favorite.projectName} ${favorite.providerName} ${favorite.modelName}`;
}

export function pickDefaultProvider(
  providers: readonly PickerProvider[],
): PickerProvider | null {
  return providers.find((provider) => provider.available) ?? providers[0] ?? null;
}

export function pickDefaultModel(
  models: readonly PickerModel[],
): PickerModel | null {
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

export function findProvider(
  providers: readonly PickerProvider[],
  providerId: string,
): PickerProvider | null {
  return providers.find((provider) => provider.id === providerId) ?? null;
}

export function findModel(
  models: readonly PickerModel[],
  model: string,
): PickerModel | null {
  return (
    models.find((entry) => entry.model === model || entry.id === model) ?? null
  );
}

export function mergeCatalogModels(
  models: readonly PickerModel[],
  selectedOnlyModels: readonly PickerModel[] = [],
): PickerModel[] {
  const merged = [...models];
  for (const extra of selectedOnlyModels) {
    if (!findModel(merged, extra.model) && !findModel(merged, extra.id)) {
      merged.push(extra);
    }
  }
  return merged;
}

export function supportedReasoningLevels(
  model: PickerModel | null,
): ReasoningLevel[] {
  if (!model) return [];
  return model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
}

export function reconcileReasoning(
  model: PickerModel | null,
  current?: ReasoningLevel | null,
): ReasoningLevel | null {
  const levels = supportedReasoningLevels(model);
  if (levels.length === 0) return null;
  if (current && levels.includes(current)) return current;
  if (model && levels.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return levels[0] ?? null;
}

export function reconcileServiceTier(
  provider: PickerProvider | null,
  current?: ServiceTier | null,
): ServiceTier | null {
  if (!provider?.supportsServiceTier) return null;
  return current ?? "default";
}

export function projectHasHost(
  project: PickerProject,
  hostId: string,
): boolean {
  if (project.kind === "personal") return true;
  return project.hostIds.includes(hostId);
}

export function catalogCacheKey(hostId: string, providerId?: string): string {
  return `${hostId}:${providerId ?? ""}`;
}

export function favoriteConfigError(
  input: {
    project: PickerProject | null;
    host: PickerHost | null;
    provider: PickerProvider | null;
    model: PickerModel | null;
    reasoningLevel: ReasoningLevel | null;
    serviceTier: ServiceTier | null;
    catalogError?: string | null;
  },
  mode: "save" | "launch",
): string | null {
  if (input.catalogError) return input.catalogError;
  if (!input.project) {
    return mode === "launch"
      ? "That project is no longer available."
      : "Choose a project.";
  }
  if (!input.host) {
    return mode === "launch"
      ? "That machine is no longer available."
      : "Choose a machine.";
  }
  if (input.host.status !== "connected") {
    return `${input.host.name} is disconnected.`;
  }
  if (!projectHasHost(input.project, input.host.id)) {
    return `${input.project.name} has no checkout on ${input.host.name}.`;
  }
  if (!input.provider) {
    return mode === "launch"
      ? `That harness is not available on ${input.host.name}.`
      : "Choose a harness.";
  }
  if (!input.provider.available) {
    return `${input.provider.displayName} is not available on ${input.host.name}.`;
  }
  if (!input.model) {
    return mode === "launch"
      ? `That model is not available for ${input.provider.displayName} on ${input.host.name}.`
      : "Choose a model.";
  }
  if (!input.reasoningLevel) {
    return mode === "launch"
      ? "That reasoning level is no longer available."
      : "Choose a reasoning level.";
  }
  if (!supportedReasoningLevels(input.model).includes(input.reasoningLevel)) {
    return `${input.model.displayName} does not support ${input.reasoningLevel}.`;
  }
  if (input.serviceTier && !input.provider.supportsServiceTier) {
    return `${input.provider.displayName} has no speed tiers.`;
  }
  if (input.provider.supportsServiceTier && !input.serviceTier) {
    return mode === "launch"
      ? `${input.provider.displayName} now requires a speed tier.`
      : "Choose Fast or Standard.";
  }
  return null;
}

export function favoriteSaveError(input: {
  project: PickerProject | null;
  host: PickerHost | null;
  provider: PickerProvider | null;
  model: PickerModel | null;
  reasoningLevel: ReasoningLevel | null;
  serviceTier: ServiceTier | null;
  catalogError?: string | null;
}): string | null {
  return favoriteConfigError(input, "save");
}

export function favoriteLaunchError(input: {
  project: PickerProject | null;
  host: PickerHost | null;
  provider: PickerProvider | null;
  model: PickerModel | null;
  reasoningLevel: ReasoningLevel | null;
  serviceTier: ServiceTier | null;
  catalogError?: string | null;
}): string | null {
  return favoriteConfigError(input, "launch");
}

export function favoriteAvailabilityError(favorite: Favorite): string | null {
  if (favorite.projectMissing) {
    return `${favorite.projectName} is no longer available.`;
  }
  if (favorite.hostStatus === "missing") {
    return `${favorite.hostName} is no longer available.`;
  }
  if (favorite.hostStatus === "disconnected") {
    return `${favorite.hostName} is disconnected.`;
  }
  return null;
}

export function environmentForFavorite(input: {
  projectKind: ProjectKind;
  hostId: string;
}):
  | {
      type: "host";
      hostId: string;
      workspace: { type: "personal" };
    }
  | {
      type: "host";
      hostId: string;
      workspace: { type: "unmanaged"; path: null };
    } {
  if (input.projectKind === "personal") {
    return {
      type: "host",
      hostId: input.hostId,
      workspace: { type: "personal" },
    };
  }
  return {
    type: "host",
    hostId: input.hostId,
    workspace: { type: "unmanaged", path: null },
  };
}

export function favoriteSeedFromConfig(input: {
  projectId: string;
  projectKind: ProjectKind;
  hostId: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | null;
}): FavoriteSeed {
  return {
    projectId: input.projectId,
    projectKind: input.projectKind,
    hostId: input.hostId,
    providerId: input.providerId,
    model: input.model,
    reasoningLevel: input.reasoningLevel,
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

export function speedLabel(tier: ServiceTier | null): string | null {
  if (tier === "fast") return "Fast";
  if (tier === "default") return "Standard";
  return null;
}

export function nextPickerState(input: {
  projects: readonly PickerProject[];
  hosts: readonly PickerHost[];
  catalog: Catalog | null;
  name?: string;
  projectId: string;
  hostId: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | "";
  serviceTier: ServiceTier | "";
}): {
  name: string;
  projectId: string;
  hostId: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | "";
  serviceTier: ServiceTier | "";
} {
  const project =
    input.projects.find((entry) => entry.id === input.projectId) ??
    input.projects[0] ??
    null;
  const hosts = input.hosts.filter(
    (host) => !project || projectHasHost(project, host.id),
  );
  const host =
    hosts.find((entry) => entry.id === input.hostId) ??
    hosts.find((entry) => entry.status === "connected") ??
    hosts[0] ??
    null;
  const name = input.name ?? "";

  if (!input.catalog) {
    return {
      name,
      projectId: project?.id ?? "",
      hostId: host?.id ?? "",
      providerId: input.providerId,
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      serviceTier: input.serviceTier,
    };
  }

  const provider =
    findProvider(input.catalog.providers, input.providerId) ??
    pickDefaultProvider(input.catalog.providers);
  const model =
    findModel(input.catalog.models, input.model) ??
    pickDefaultModel(input.catalog.models);
  const reasoning = reconcileReasoning(model, input.reasoningLevel || null);
  const serviceTier = reconcileServiceTier(provider, input.serviceTier || null);

  return {
    name,
    projectId: project?.id ?? "",
    hostId: host?.id ?? "",
    providerId: provider?.id ?? "",
    model: model?.model ?? "",
    reasoningLevel: reasoning ?? "",
    serviceTier: serviceTier ?? "",
  };
}
