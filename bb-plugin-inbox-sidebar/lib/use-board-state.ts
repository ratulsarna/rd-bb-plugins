import type { PipelinePullRequest } from "@/server";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarProject,
} from "@get-bb/plugin-sdk/app";
import { usePipelinePullRequests } from "@/lib/use-pipeline-pull-requests";
import { useSettledOverrides } from "@/lib/use-settled";
import { usePinnedOrder } from "@/lib/use-pinned-order";
import { selectedAssistantsProjectId } from "@/lib/assistant-identity";
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
  pullRequests: ReadonlyMap<string, PipelinePullRequest | null>;
  now: number;
  settle(threadId: string): void;
  unsettle(threadId: string): void;
  snooze(threadId: string, until: number): void;
  wake(threadId: string): void;
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
 * The assistant fleet is excluded here — it renders as the board's own Bots
 * section, not as board rows.
 */
export function useBoardState(
  /** Threads on screen (route and split panes); opening one acknowledges its woken snooze. */
  openThreadIds: readonly string[] = [],
): BoardState {
  const {
    status: threadStatus,
    threads: allThreads,
    projects: allProjects,
  } = useSidebarThreads();
  const assistantProjectId = selectedAssistantsProjectId(allProjects);
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) => project.id !== assistantProjectId,
      ),
    [allProjects, assistantProjectId],
  );
  const threads = useMemo(() => {
    if (assistantProjectId === null) return allThreads;
    return allThreads.filter(
      (thread) => thread.projectId !== assistantProjectId,
    );
  }, [assistantProjectId, allThreads]);
  const settledApi = useSettledOverrides();
  const pinnedApi = usePinnedOrder();
  const pullRequests = usePipelinePullRequests(threads);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // A wake is stamped with the server's now, which is past the last minute
  // tick: without a fresh sample the row would stay snoozed until the next.
  const overrides = settledApi.overrides;
  useEffect(() => setNow(Date.now()), [overrides]);

  // Read from the overrides, not the board, so an open thread is acknowledged
  // in any section: pinned or nested, its marker would otherwise come back.
  // Keys are id:until, so a later snooze of the same thread is acknowledged
  // again, and a re-render is not.
  const acknowledgeWake = settledApi.acknowledgeWake;
  const acknowledged = useRef(new Set<string>());
  useEffect(() => {
    const sent = new Set<string>();
    for (const threadId of openThreadIds) {
      const mark = overrides.get(threadId);
      if (mark?.override !== "snoozed" || mark.until > now) continue;
      const key = `${threadId}:${mark.until}`;
      sent.add(key);
      if (!acknowledged.current.has(key)) acknowledgeWake(threadId, mark.until);
    }
    acknowledged.current = sent;
  }, [acknowledgeWake, now, openThreadIds, overrides]);

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
        overrides,
        pinnedOrder: pinnedApi.ids,
        mergedPipelineThreadIds: new Set(
          [...pullRequests].filter(([, pr]) => pr?.state === "merged").map(([id]) => id),
        ),
      }),
    [now, pinnedApi.ids, overrides, threads, pullRequests],
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
    snooze: settledApi.snooze,
    wake: settledApi.wake,
    pinnedOrderReady: pinnedApi.ready,
    pinnedOrderMoving: pinnedApi.moving,
    movePinned: pinnedApi.move,
  };
}
