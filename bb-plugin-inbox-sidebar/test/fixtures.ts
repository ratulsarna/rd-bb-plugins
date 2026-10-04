import type { BoardThread, ThreadOverride } from "@/lib/lanes";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";

export const NOW = Date.now();
export const HOUR = 60 * 60 * 1_000;
export const DAY = 24 * HOUR;

export function project(id: string, name: string): PluginSidebarProject {
  return {
    id,
    name,
    isPersonal: false,
    href: `/projects/${id}`,
    settingsHref: `/settings/projects/${id}`,
  };
}

export function thread(
  id: string,
  overrides: Partial<BoardThread> = {},
): BoardThread {
  return {
    id,
    projectId: "project-1",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    providerId: "codex",
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
    href: `/projects/${overrides.projectId ?? "project-1"}/threads/${id}`,
    createdAt: NOW - DAY,
    latestAttentionAt: NOW,
    ...overrides,
  };
}

export function overrideMap(
  entries: Array<[string, "settled" | "active", number]>,
): Map<string, ThreadOverride> {
  return new Map(entries.map(([id, override, at]) => [id, { override, at }]));
}
