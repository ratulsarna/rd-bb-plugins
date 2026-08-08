import type {
  PluginSidebarThread,
  PluginSidebarThreadActivity,
} from "@bb/plugin-sdk/app";

export const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1_000;

/** Per-thread urgency, shown as the card's status slot — never as position. */
export type Lane = "needs-you" | "running" | "idle";

export type PrState = "draft" | "open" | "merged" | "closed";

export type TreePr = "in-flight" | "unknown" | "clear";

/**
 * A user override from the plugin store. "settled" parks a thread the timer
 * would have kept; "active" un-parks one auto-settle would otherwise take
 * right back. Both go stale on new activity — and an "active" override also
 * expires once the thread has been quiet past the cutoff again, so unsettling
 * is "keep this around for now", not "never settle this".
 */
export interface SettledOverride {
  override: "settled" | "active";
  at: number;
}

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
  | "createdAt"
  | "latestAttentionAt"
> & {
  indicator: string;
};

export interface BoardItem<T extends BoardThread = BoardThread> {
  thread: T;
  lane: Lane;
  latestActivityAt: number;
  hasPinnedThread: boolean;
  treePr: TreePr;
  children: BoardItem<T>[];
}

export interface SettledBoardItem<T extends BoardThread = BoardThread>
  extends BoardItem<T> {
  settledAt: number;
  /** True when the board settled it (quiet or PR done), not the user. */
  isAuto: boolean;
}

export interface BoardProjection<T extends BoardThread = BoardThread> {
  /** Pinned threads — the user's own priority shelf. */
  pinned: BoardItem<T>[];
  /** Active work, newest thread first. Activity never re-orders it. */
  inbox: BoardItem<T>[];
  /** Done work, most recently settled first. */
  settled: SettledBoardItem<T>[];
}

interface BuildBoardOptions {
  now?: number;
  idleCutoffMs?: number;
  /** User overrides from the plugin store. */
  overrides?: ReadonlyMap<string, SettledOverride>;
  /** Missing is unknown; null means the lookup found no pull request. */
  prStates?: ReadonlyMap<string, PrState | null>;
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

export function threadDisplayTitle(thread: BoardThread): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
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

/**
 * Whether the user may settle this item. Live work and a raised hand always
 * block it — hiding a working thread is the one failure this board cannot
 * afford. Pinned threads are the priority shelf, so they don't settle either.
 */
export function canSettle(
  item: Pick<BoardItem, "lane" | "hasPinnedThread" | "treePr">,
): boolean {
  return (
    item.lane === "idle" && !item.hasPinnedThread && item.treePr === "clear"
  );
}

function moreUrgent(a: Lane, b: Lane): Lane {
  return LANE_URGENCY[a] >= LANE_URGENCY[b] ? a : b;
}

function prForThread(
  threadId: string,
  prStates: ReadonlyMap<string, PrState | null>,
): TreePr {
  if (!prStates.has(threadId)) return "unknown";
  const state = prStates.get(threadId);
  return state === "open" || state === "draft" ? "in-flight" : "clear";
}

function moreBlockingPr(a: TreePr, b: TreePr): TreePr {
  if (a === "in-flight" || b === "in-flight") return "in-flight";
  if (a === "unknown" || b === "unknown") return "unknown";
  return "clear";
}

export function buildBoard<T extends BoardThread>(
  threads: readonly T[],
  options: BuildBoardOptions = {},
): BoardProjection<T> {
  const now = options.now ?? Date.now();
  const idleCutoffMs = options.idleCutoffMs ?? TWO_DAYS_MS;
  const overrides = options.overrides ?? new Map<string, SettledOverride>();
  const prStates = options.prStates ?? new Map<string, PrState | null>();
  // Every non-archived thread, always. Search and project scoping are display
  // concerns and must never reach classification — see filterBoardForDisplay.
  const visible = threads.filter((thread) => !thread.isArchived);
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
    treePr: TreePr;
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
      treePr: prForThread(threadId, prStates),
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
          treePr: moreBlockingPr(current.treePr, child.treePr),
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

  const pinned: BoardItem<T>[] = [];
  const inbox: BoardItem<T>[] = [];
  const settled: SettledBoardItem<T>[] = [];

  for (const item of roots) {
    if (item.thread.isPinned) {
      pinned.push(item);
      continue;
    }
    // Live work or a raised hand anywhere in the tree always wins: a settled
    // thread that starts working or asks a question comes straight back.
    if (item.lane !== "idle") {
      inbox.push(item);
      continue;
    }
    const mark = overrides.get(item.thread.id);
    if (mark?.override === "settled") {
      // New attention since the settle un-settles it: the thread has more to
      // say than it did when the user filed it away. Known unfinished work and
      // pinned descendants also keep the tree visible; unknown PR state honors
      // the user's mark until a probe reports otherwise.
      if (
        item.latestActivityAt > mark.at ||
        item.hasPinnedThread ||
        item.treePr === "in-flight"
      ) {
        inbox.push(item);
      } else {
        settled.push({ ...item, settledAt: mark.at, isAuto: false });
      }
      continue;
    }
    // An "active" override restarts the quiet clock from when the user set
    // it, so auto-settle backs off for a full cutoff window and then resumes.
    const activeOverrideAt = mark?.override === "active" ? mark.at : null;
    const quietSince = Math.max(item.latestActivityAt, activeOverrideAt ?? 0);
    const quiet = now - quietSince > idleCutoffMs;
    const pr = prStates.get(item.thread.id);
    if (
      (pr === "merged" || pr === "closed") &&
      item.treePr === "clear" &&
      !item.hasPinnedThread &&
      (activeOverrideAt === null || quiet)
    ) {
      // The PR resolving is the work resolving — settle right away.
      settled.push({ ...item, settledAt: quietSince, isAuto: true });
      continue;
    }
    // An in-flight PR is unfinished business no matter how quiet the thread:
    // review can take days, and settling would bury the work waiting on it.
    // Unknown PR state and a pinned descendant block auto-settle the same way.
    if (quiet && canSettle(item)) {
      settled.push({ ...item, settledAt: quietSince, isAuto: true });
      continue;
    }
    inbox.push(item);
  }

  // The sort that defines this board: newest thread on top, and nothing moves
  // it afterwards. Status lives on the card, not in its position.
  const byCreatedDesc = (a: BoardItem<T>, b: BoardItem<T>) =>
    b.thread.createdAt - a.thread.createdAt ||
    a.thread.id.localeCompare(b.thread.id);
  pinned.sort(byCreatedDesc);
  inbox.sort(byCreatedDesc);
  // Settled rows are history, so they order by when the work ended.
  settled.sort(
    (a, b) => b.settledAt - a.settledAt || a.thread.id.localeCompare(b.thread.id),
  );

  return { pinned, inbox, settled };
}

/**
 * Probe every root. Hidden descendants are skipped only when their tree is
 * pinned or is unsettled and non-idle; expanded rows are always included.
 */
export function selectPrProbeTargets<T extends BoardThread>(
  board: BoardProjection<T>,
  expandedIds: ReadonlySet<string>,
  showSettled: boolean,
): Set<string> {
  const targets = new Set<string>();

  const visitTree = (
    root: BoardItem<T>,
    probeAllDescendants: boolean,
    rootRendered: boolean,
  ) => {
    const visit = (item: BoardItem<T>, isRoot: boolean, rendered: boolean) => {
      if (isRoot || probeAllDescendants || rendered) {
        targets.add(item.thread.id);
      }
      const childrenRendered = rendered && expandedIds.has(item.thread.id);
      for (const child of item.children) {
        visit(child, false, childrenRendered);
      }
    };
    visit(root, true, rootRendered);
  };

  for (const root of board.pinned) visitTree(root, false, true);
  for (const root of board.inbox) {
    visitTree(
      root,
      root.lane === "idle" && !root.hasPinnedThread,
      true,
    );
  }
  for (const root of board.settled) visitTree(root, true, showSettled);

  return targets;
}
