import type {
  PluginSidebarThread,
  PluginSidebarThreadActivity,
} from "@bb/plugin-sdk/app";

export const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1_000;

export type Lane = "needs-you" | "running" | "idle";

export type BoardThread = Pick<
  PluginSidebarThread,
  | "id"
  | "projectId"
  | "title"
  | "titleFallback"
  | "parentThreadId"
  | "providerId"
  | "hasPendingInteraction"
  | "activity"
  | "indicatorLabel"
  | "isUnread"
  | "isPinned"
  | "isArchived"
  | "environment"
  | "host"
  | "latestAttentionAt"
> & {
  indicator: string;
};

export interface BoardItem<T extends BoardThread = BoardThread> {
  thread: T;
  lane: Lane;
  latestActivityAt: number;
  hasPinnedThread: boolean;
  children: BoardItem<T>[];
}

export interface BoardProjection<T extends BoardThread = BoardThread> {
  lanes: Record<Lane, BoardItem<T>[]>;
  hiddenIdleCount: number;
}

interface BuildBoardOptions {
  now?: number;
  idleCutoffMs?: number;
  projectId?: string | null;
}

const NEEDS_YOU_INDICATORS = new Set([
  "unread-error",
  "waiting-for-input",
]);

const RUNNING_INDICATORS = new Set([
  "plan-mode",
  "goal",
  "runtime",
  "workflow",
  "background-agent",
  "background-command",
  "working-draft",
]);

const LANE_URGENCY: Record<Lane, number> = {
  idle: 0,
  running: 1,
  "needs-you": 2,
};

function hasActivity(activity: PluginSidebarThreadActivity): boolean {
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0
  );
}

function isUnreadSettledChild(thread: BoardThread): boolean {
  return Boolean(
    thread.parentThreadId &&
      thread.isUnread &&
      thread.indicator === "none" &&
      !hasActivity(thread.activity),
  );
}

export function laneForThread(thread: BoardThread): Lane {
  if (
    thread.hasPendingInteraction ||
    NEEDS_YOU_INDICATORS.has(thread.indicator)
  ) {
    return "needs-you";
  }
  if (isUnreadSettledChild(thread)) {
    return "needs-you";
  }
  if (RUNNING_INDICATORS.has(thread.indicator) || hasActivity(thread.activity)) {
    return "running";
  }
  return "idle";
}

export function statusLabelForItem(
  item: Pick<BoardItem, "thread" | "lane">,
): string | undefined {
  const ownLane = laneForThread(item.thread);
  if (item.lane !== ownLane) {
    if (item.lane === "needs-you") return "Subagent needs attention";
    if (item.lane === "running") return "Subagent running";
  }
  if (item.thread.indicatorLabel) return item.thread.indicatorLabel;
  if (isUnreadSettledChild(item.thread)) return "Unread subagent result";
  if (ownLane === "needs-you") return "Thread needs attention";
  if (ownLane === "running") return "Thread running";
  return undefined;
}

function moreUrgent(a: Lane, b: Lane): Lane {
  return LANE_URGENCY[a] >= LANE_URGENCY[b] ? a : b;
}

export function buildBoard<T extends BoardThread>(
  threads: readonly T[],
  options: BuildBoardOptions = {},
): BoardProjection<T> {
  const now = options.now ?? Date.now();
  const idleCutoffMs = options.idleCutoffMs ?? TWO_DAYS_MS;
  const visible = threads.filter(
    (thread) =>
      !thread.isArchived &&
      (!options.projectId || thread.projectId === options.projectId),
  );
  const byId = new Map(visible.map((thread) => [thread.id, thread] as const));
  const childrenByParent = new Map<string, string[]>();

  for (const thread of visible) {
    const parentId = thread.parentThreadId;
    if (!parentId || !byId.has(parentId) || parentId === thread.id) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(thread.id);
    childrenByParent.set(parentId, children);
  }

  type Rollup = {
    lane: Lane;
    latestActivityAt: number;
    hasPinnedThread: boolean;
  };
  const rollups = new Map<string, Rollup>();

  const evaluate = (threadId: string, visiting: Set<string>): Rollup => {
    const cached = rollups.get(threadId);
    if (cached) return cached;

    const thread = byId.get(threadId)!;
    const own: Rollup = {
      lane: laneForThread(thread),
      latestActivityAt: thread.latestAttentionAt,
      hasPinnedThread: thread.isPinned,
    };
    if (visiting.has(threadId)) return own;

    const nextVisiting = new Set(visiting).add(threadId);
    const result = (childrenByParent.get(threadId) ?? []).reduce<Rollup>(
      (current, childId) => {
        const child = evaluate(childId, nextVisiting);
        return {
          lane: moreUrgent(current.lane, child.lane),
          latestActivityAt: Math.max(
            current.latestActivityAt,
            child.latestActivityAt,
          ),
          hasPinnedThread: current.hasPinnedThread || child.hasPinnedThread,
        };
      },
      own,
    );
    rollups.set(threadId, result);
    return result;
  };

  const emitted = new Set<string>();
  const makeItem = (threadId: string): BoardItem<T> | null => {
    if (emitted.has(threadId)) return null;
    emitted.add(threadId);
    const rollup = evaluate(threadId, new Set());
    const children = (childrenByParent.get(threadId) ?? [])
      .map(makeItem)
      .filter((item): item is BoardItem<T> => item !== null);
    return {
      thread: byId.get(threadId)!,
      ...rollup,
      children,
    };
  };

  const rootIds = visible
    .filter(
      (thread) =>
        !thread.parentThreadId || !byId.has(thread.parentThreadId),
    )
    .map((thread) => thread.id);
  const roots = rootIds
    .map(makeItem)
    .filter((item): item is BoardItem<T> => item !== null);

  // Corrupt cyclic ancestry has no natural root. Promote one member so the
  // threads stay visible, while `emitted` prevents recursive loops.
  for (const thread of visible) {
    const item = makeItem(thread.id);
    if (item) roots.push(item);
  }

  const lanes: BoardProjection<T>["lanes"] = {
    "needs-you": [],
    running: [],
    idle: [],
  };
  let hiddenIdleCount = 0;

  for (const item of roots) {
    const isOldIdle =
      item.lane === "idle" &&
      now - item.latestActivityAt > idleCutoffMs &&
      !item.hasPinnedThread;
    if (isOldIdle) {
      hiddenIdleCount += 1;
      continue;
    }
    lanes[item.lane].push(item);
  }

  for (const lane of Object.values(lanes)) {
    lane.sort((a, b) => b.latestActivityAt - a.latestActivityAt);
  }

  return { lanes, hiddenIdleCount };
}
