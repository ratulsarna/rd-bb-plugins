import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarProject,
  type PluginSidebarPullRequest,
} from "@bb/plugin-sdk/app";
import { useSettledOverrides } from "@/lib/use-settled";
import { usePinnedOrder } from "@/lib/use-pinned-order";
import {
  buildBoard,
  type BoardProjection,
  type BoardThread,
  type PrState,
} from "@/lib/lanes";

export interface BoardState {
  threadStatus: "loading" | "ready" | "error";
  overridesStatus: "loading" | "ready" | "error";
  retryOverrides(): void;
  projects: readonly PluginSidebarProject[];
  /** The full projection over every non-archived thread. Never filtered. */
  board: BoardProjection<BoardThread>;
  pullRequests: ReadonlyMap<string, PluginSidebarPullRequest | null>;
  reportPullRequest(
    threadId: string,
    pullRequest: PluginSidebarPullRequest | null,
  ): void;
  now: number;
  settle(threadId: string): void;
  unsettle(threadId: string): void;
  /** False until the order is known; every move affordance waits on it. */
  pinnedOrderReady: boolean;
  /** Serializes pin moves until BB returns a canonical order. */
  pinnedOrderMoving: boolean;
  movePinned(
    threadId: string,
    previousThreadId: string | null,
    nextThreadId: string | null,
  ): void;
}

function samePullRequest(
  left: PluginSidebarPullRequest | null | undefined,
  right: PluginSidebarPullRequest | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.number === right.number &&
    left.title === right.title &&
    left.url === right.url &&
    left.state === right.state &&
    left.attention === right.attention
  );
}

/**
 * Everything both board surfaces share: threads, the user's settle marks, the
 * PR snapshot the probes fill in, and the projection built from all three.
 *
 * It deliberately takes no search or project input. Whatever the surface hides
 * on screen, the classification underneath is computed over every thread.
 */
export function useBoardState(): BoardState {
  const { status: threadStatus, threads, projects } = useSidebarThreads();
  const settledApi = useSettledOverrides();
  const pinnedApi = usePinnedOrder();
  const [pullRequests, setPullRequests] = useState<
    Map<string, PluginSidebarPullRequest | null>
  >(() => new Map());
  const [prResolvedAt, setPrResolvedAt] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // The last PR state we accepted per thread. A snapshot map can only say what
  // a PR is, never that it just changed, and "when did this merge" is exactly
  // the moment we need to date a settle by.
  const lastPrState = useRef(new Map<string, PrState | null>());

  const reportPullRequest = useCallback(
    (threadId: string, pullRequest: PluginSidebarPullRequest | null) => {
      const incoming = pullRequest?.state ?? null;
      const before = lastPrState.current.get(threadId);
      const sticky =
        pullRequest === null && (before === "open" || before === "draft");
      if (!sticky) {
        lastPrState.current.set(threadId, incoming);
        const wasResolved = before === "merged" || before === "closed";
        const isResolved = incoming === "merged" || incoming === "closed";
        // Only a transition we actually watched counts. A cold load that finds
        // a PR already merged says nothing about when it merged, so it falls
        // back to dating the settle by the thread's own quiet clock.
        if (before !== undefined && isResolved && !wasResolved) {
          const at = Date.now();
          setPrResolvedAt((current) => {
            if (current.has(threadId)) return current;
            return new Map(current).set(threadId, at);
          });
        }
      }
      setPullRequests((current) => {
        const existing = current.get(threadId);
        if (
          pullRequest === null &&
          (existing?.state === "open" || existing?.state === "draft")
        ) {
          return current;
        }
        if (current.has(threadId) && samePullRequest(existing, pullRequest)) {
          return current;
        }
        const next = new Map(current);
        next.set(threadId, pullRequest);
        return next;
      });
    },
    [],
  );

  const liveThreadIds = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => !thread.isArchived)
          .map((thread) => thread.id),
      ),
    [threads],
  );

  useEffect(() => {
    const prune = <V,>(current: ReadonlyMap<string, V>) => {
      let changed = false;
      const next = new Map(current);
      for (const threadId of next.keys()) {
        if (!liveThreadIds.has(threadId)) {
          next.delete(threadId);
          changed = true;
        }
      }
      return changed ? next : current;
    };
    setPullRequests((current) => prune(current) as typeof current);
    setPrResolvedAt(prune);
    for (const threadId of lastPrState.current.keys()) {
      if (!liveThreadIds.has(threadId)) lastPrState.current.delete(threadId);
    }
  }, [liveThreadIds]);

  // Pinning happens outside our RPC — our own context menu pins through the
  // host — so nothing publishes on the pinned-order channel. Watch which
  // threads are pinned instead, and re-read bb's order whenever that changes.
  // Membership only: a same-set reorder made elsewhere is a known gap.
  const pinnedMembership = useMemo(
    () =>
      threads
        .filter(
          (thread) =>
            !thread.isArchived &&
            thread.isPinned &&
            thread.parentThreadId === null,
        )
        .map((thread) => thread.id)
        .sort()
        .join("\0"),
    [threads],
  );
  const refreshPinnedOrder = pinnedApi.refresh;
  // Seeded with the first value, so mount's own fetch isn't doubled.
  const previousPinnedMembership = useRef(pinnedMembership);
  useEffect(() => {
    if (previousPinnedMembership.current === pinnedMembership) return;
    previousPinnedMembership.current = pinnedMembership;
    void refreshPinnedOrder();
  }, [pinnedMembership, refreshPinnedOrder]);

  const prStates = useMemo(
    () =>
      new Map<string, PrState | null>(
        [...pullRequests].map(([threadId, pullRequest]) => [
          threadId,
          pullRequest?.state ?? null,
        ]),
      ),
    [pullRequests],
  );
  const board = useMemo<BoardProjection<BoardThread>>(
    () =>
      buildBoard(threads, {
        now,
        overrides: settledApi.overrides,
        prStates,
        prResolvedAt,
        pinnedOrder: pinnedApi.ids,
      }),
    [
      now,
      pinnedApi.ids,
      prResolvedAt,
      prStates,
      settledApi.overrides,
      threads,
    ],
  );

  return {
    threadStatus,
    overridesStatus: settledApi.status,
    retryOverrides: () => void settledApi.refresh(),
    projects,
    board,
    pullRequests,
    reportPullRequest,
    now,
    settle: settledApi.settle,
    unsettle: settledApi.unsettle,
    pinnedOrderReady: pinnedApi.ready,
    pinnedOrderMoving: pinnedApi.moving,
    movePinned: pinnedApi.move,
  };
}
