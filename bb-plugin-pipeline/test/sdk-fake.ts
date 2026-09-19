import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { Card } from "../lib/store";

export function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card_1",
    projectId: "proj_1",
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
