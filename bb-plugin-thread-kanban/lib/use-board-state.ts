import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarProject,
  type PluginSidebarPullRequest,
} from "@bb/plugin-sdk/app";
import { useSettledOverrides } from "@/lib/use-settled";
import {
  buildBoard,
  selectPrProbeTargets,
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
  probeTargetIds: string[];
  pullRequests: ReadonlyMap<string, PluginSidebarPullRequest | null>;
  reportPullRequest(
    threadId: string,
    pullRequest: PluginSidebarPullRequest | null,
  ): void;
  now: number;
  settle(threadId: string): void;
  unsettle(threadId: string): void;
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
export function useBoardState(
  expandedIds: ReadonlySet<string>,
  showSettled: boolean,
): BoardState {
  const { status: threadStatus, threads, projects } = useSidebarThreads();
  const settledApi = useSettledOverrides();
  const [pullRequests, setPullRequests] = useState<
    Map<string, PluginSidebarPullRequest | null>
  >(() => new Map());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const reportPullRequest = useCallback(
    (threadId: string, pullRequest: PluginSidebarPullRequest | null) => {
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
    setPullRequests((current) => {
      let changed = false;
      const next = new Map(current);
      for (const threadId of next.keys()) {
        if (!liveThreadIds.has(threadId)) {
          next.delete(threadId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [liveThreadIds]);

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
      }),
    [now, prStates, settledApi.overrides, threads],
  );
  const probeTargetIds = useMemo(
    () => [...selectPrProbeTargets(board, expandedIds, showSettled)],
    [board, expandedIds, showSettled],
  );

  return {
    threadStatus,
    overridesStatus: settledApi.status,
    retryOverrides: () => void settledApi.refresh(),
    projects,
    board,
    probeTargetIds,
    pullRequests,
    reportPullRequest,
    now,
    settle: settledApi.settle,
    unsettle: settledApi.unsettle,
  };
}
