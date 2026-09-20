import type { PluginBbSdk, PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { ExecutionSelection } from "../lib/execution";
import type { Card } from "../lib/store";

export type TestProviderListResult = Awaited<
  ReturnType<PluginBbSdk["providers"]["list"]>
>;
export type TestProviderModelsResult = Awaited<
  ReturnType<PluginBbSdk["providers"]["models"]>
>;
export type TestProviderListInput = NonNullable<
  Parameters<PluginBbSdk["providers"]["list"]>[0]
>;
export type TestProviderModelsInput = NonNullable<
  Parameters<PluginBbSdk["providers"]["models"]>[0]
>;

export function makeCatalogProvider(
  id: string,
  supportsServiceTier = false,
  available = true,
): TestProviderListResult[number] {
  return {
    id,
    displayName: id,
    available,
    pluginId: `provider-${id}`,
    logoUrl: null,
    completedTurnDisplay: "flat",
    composerActions: [],
    maintenance: { health: false, installation: false, usage: false },
    capabilities: {
      modelCatalogScope: "host",
      permissionModes: ["accept-edits", "auto", "full"],
      supportsFork: true,
      supportsNativeUserQuestion: true,
      supportsServiceTier,
      supportsSessionRewind: false,
      supportsThreadArchive: true,
      supportsThreadRename: true,
    },
    ...(supportsServiceTier
      ? {
          serviceTiers: [
            { id: "default", label: "Default" },
            { id: "fast", label: "Fast" },
          ],
        }
      : {}),
  };
}

export function makeCatalogModel(
  model: string,
  reasoningLevels: ExecutionSelection["reasoningLevel"][],
): TestProviderModelsResult["models"][number] {
  return {
    id: model,
    model,
    displayName: model,
    description: model,
    isDefault: true,
    defaultReasoningEffort: reasoningLevels[0]!,
    supportedReasoningEfforts: reasoningLevels.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
  };
}

export const testCatalogProviders: TestProviderListResult = [
  makeCatalogProvider("claude-code"),
  makeCatalogProvider("pi"),
  makeCatalogProvider("codex", true),
];

export function testProviderModels(
  providerId: string | undefined,
): TestProviderModelsResult {
  const modelsByProvider: Record<string, TestProviderModelsResult["models"]> = {
    "claude-code": [makeCatalogModel("claude-fable-5-1", ["high"])],
    pi: [
      makeCatalogModel("zai/glm-5.3-flash", ["none", "high"]),
      makeCatalogModel("zai/glm-5.3-air", ["max"]),
    ],
    codex: [
      makeCatalogModel("gpt-6-astra", ["ultra"]),
      makeCatalogModel("gpt-5.6-sol", ["ultra"]),
    ],
  };
  return {
    providers: testCatalogProviders,
    models: modelsByProvider[providerId ?? ""] ?? [],
    selectedOnlyModels:
      providerId === "codex"
        ? [makeCatalogModel("gpt-5.6-luna", ["medium", "low"])]
        : [],
    modelLoadError: null,
    permissionCeiling: "full",
  };
}

export function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card_1",
    projectId: "proj_1",
    hostId: "host_mac",
    intake: null,
    lead: null,
    title: "A pipeline card",
    body: "",
    attachments: [],
    column: "backlog",
    needsUser: false,
    attentionReason: null,
    attentionSource: null,
    attentionUnknown: false,
    reportSignal: null,
    tier: null,
    issueUrl: null,
    prUrl: null,
    intakeThreadId: "intake",
    leadThreadId: null,
    ownerRole: "intake",
    threadError: null,
    launchError: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function makeSidebarThread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "intake",
    projectId: "proj_1",
    title: "Intake",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: "pipeline",
    providerId: "claude-code",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: 1,
    latestAttentionAt: 1,
    ...overrides,
  };
}
