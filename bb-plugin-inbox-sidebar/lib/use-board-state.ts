import { useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarProject,
  type PluginSidebarPullRequest,
} from "@bb/plugin-sdk/app";
import { usePipelinePullRequests } from "@/lib/use-pipeline-pull-requests";
import { useSettledOverrides } from "@/lib/use-settled";
import { usePinnedOrder } from "@/lib/use-pinned-order";
import {
  buildBoard,
  type BoardProjection,
  type BoardThread,
} from "@/lib/lanes";

export interface BoardState {
  threadStatus: "loading" | "ready" | "error";
  overridesStatus: "loading" | "ready" | "error";
  retryOverrides(): void;
  projects: readonly PluginSidebarProject[];
  /** The full projection over every non-archived thread. Never filtered. */
  board: BoardProjection<BoardThread>;
  pullRequests: ReadonlyMap<string, PluginSidebarPullRequest | null>;
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

/**
 * Everything both board surfaces share: threads, the user's settle marks, the
 * Pipeline PR state, and the board projection.
 *
 * It deliberately takes no search or project input. Whatever the surface hides
 * on screen, the classification underneath is computed over every thread.
 */
/**
 * The assistant fleet renders as the board's own Bots section, not as board
 * rows. Its project and threads never reach the lanes.
 */
export const ASSISTANTS_PROJECT_NAME = "assistants";

export function useBoardState(): BoardState {
  const {
    status: threadStatus,
    threads: allThreads,
    projects: allProjects,
  } = useSidebarThreads();
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) => project.name.toLowerCase() !== ASSISTANTS_PROJECT_NAME,
      ),
    [allProjects],
  );
  const threads = useMemo(() => {
    const assistantProjectIds = new Set(
      allProjects
        .filter(
          (project) => project.name.toLowerCase() === ASSISTANTS_PROJECT_NAME,
        )
        .map((project) => project.id),
    );
    if (assistantProjectIds.size === 0) return allThreads;
    return allThreads.filter(
      (thread) => !assistantProjectIds.has(thread.projectId),
    );
  }, [allProjects, allThreads]);
  const settledApi = useSettledOverrides();
  const pinnedApi = usePinnedOrder();
  const pullRequests = usePipelinePullRequests(threads);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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

  const board = useMemo<BoardProjection<BoardThread>>(
    () =>
      buildBoard(threads, {
        now,
        overrides: settledApi.overrides,
        pinnedOrder: pinnedApi.ids,
        mergedPipelineThreadIds: new Set(
          [...pullRequests].filter(([, pr]) => pr?.state === "merged").map(([id]) => id),
        ),
      }),
    [now, pinnedApi.ids, settledApi.overrides, threads, pullRequests],
  );

  return {
    threadStatus,
    overridesStatus: settledApi.status,
    retryOverrides: () => void settledApi.refresh(),
    projects,
    board,
    pullRequests,
    now,
    settle: settledApi.settle,
    unsettle: settledApi.unsettle,
    pinnedOrderReady: pinnedApi.ready,
    pinnedOrderMoving: pinnedApi.moving,
    movePinned: pinnedApi.move,
  };
}
