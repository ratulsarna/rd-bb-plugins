import type { BoardThread, SettledOverride } from "@/lib/lanes";

export const NOW = Date.now();
export const HOUR = 60 * 60 * 1_000;
export const DAY = 24 * HOUR;

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
    createdAt: NOW - DAY,
    latestAttentionAt: NOW,
    ...overrides,
  };
}

export function overrideMap(
  entries: Array<[string, SettledOverride["override"], number]>,
): Map<string, SettledOverride> {
  return new Map(entries.map(([id, override, at]) => [id, { override, at }]));
}
