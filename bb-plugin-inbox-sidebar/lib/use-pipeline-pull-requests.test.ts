// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { configureFakeSdk, pendingRpc, resolvePendingRpc, rejectPendingRpc, rpcCalls, setFakeThreads } from "@/test/sdk-fake";
import { thread } from "@/test/fixtures";
import { useBoardState } from "./use-board-state";

const pr = { number: 41, title: "Task", url: "https://github.com/example/repo/pull/41", state: "merged" };
const rows = (id: string, pullRequest: unknown = pr) => ({ rows: [{ threadId: id, pullRequest }] });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("settles without any mounted rows, waits for idle, and clears an unlinked PR", async () => {
  vi.useFakeTimers();
  configureFakeSdk({ threads: [thread("lead", { indicator: "runtime" }), thread("ordinary")], deferRpc: ["threadPullRequests"] });
  const { result, rerender } = renderHook(() => useBoardState());
  await act(async () => resolvePendingRpc("threadPullRequests", "oldest", rows("lead")));
  expect(result.current.board.settled).toHaveLength(0);
  setFakeThreads([thread("lead"), thread("ordinary")]);
  rerender();
  expect(result.current.board.settled.map((item) => item.thread.id)).toEqual(["lead"]);
  expect(result.current.board.inbox.map((item) => item.thread.id)).toEqual(["ordinary"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  await act(async () => resolvePendingRpc("threadPullRequests", "oldest", rows("lead", null)));
  expect(result.current.board.settled).toHaveLength(0);
});

it("batches hidden children, excludes archives, and ignores responses after membership changes", async () => {
  configureFakeSdk({
    threads: [...Array.from({ length: 101 }, (_, i) => thread(`t${i}`, { parentThreadId: i ? "t0" : null })), thread("archived", { isArchived: true })],
    deferRpc: ["threadPullRequests"],
  });
  const { result, rerender } = renderHook(() => useBoardState());
  const first = pendingRpc.find((call) => call.method === "threadPullRequests")!;
  expect((first.input as { threadIds: string[] }).threadIds).toHaveLength(100);
  await act(async () => resolvePendingRpc("threadPullRequests", "oldest", { rows: [] }));
  const last = pendingRpc.find((call) => call.method === "threadPullRequests")!;
  expect((last.input as { threadIds: string[] }).threadIds).toHaveLength(1);
  expect(JSON.stringify(rpcCalls.filter((call) => call.method === "threadPullRequests"))).not.toContain("archived");
  setFakeThreads([thread("replacement")]);
  rerender();
  await act(async () => resolvePendingRpc("threadPullRequests", "newest", rows("replacement", null)));
  await act(async () => resolvePendingRpc("threadPullRequests", "oldest", rows("t0")));
  expect([...result.current.pullRequests.keys()]).toEqual(["replacement"]);
});

it("drops badges when Pipeline fails, retries, and stops polling on unmount", async () => {
  vi.useFakeTimers();
  configureFakeSdk({ threads: [thread("lead")], deferRpc: ["threadPullRequests"] });
  const { result, unmount } = renderHook(() => useBoardState());
  await act(async () => resolvePendingRpc("threadPullRequests", "oldest", rows("lead")));
  expect(result.current.board.settled).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  await act(async () => rejectPendingRpc("threadPullRequests", "oldest", new Error("disabled")));
  expect(result.current.pullRequests.size).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  await act(async () => resolvePendingRpc("threadPullRequests", "oldest", rows("lead")));
  expect(result.current.board.settled).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  unmount();
  await act(async () => resolvePendingRpc("threadPullRequests", "oldest", rows("lead")));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(pendingRpc.filter((call) => call.method === "threadPullRequests")).toHaveLength(0);
});
