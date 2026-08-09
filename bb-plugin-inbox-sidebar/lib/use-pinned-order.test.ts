// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  configureFakeSdk,
  rejectPendingRpc,
  resolvePendingRpc,
  rpcCalls,
  setFakePinnedOrder,
} from "@/test/sdk-fake";
import { usePinnedOrder } from "./use-pinned-order";

afterEach(cleanup);

describe("usePinnedOrder request sequencing", () => {
  // One counter covers reads and writes precisely so this cannot happen: a
  // list read already on the wire when the user drags a row would otherwise
  // land afterwards and snap the row back where it started.
  it("does not let a stale read undo a move that landed first", async () => {
    configureFakeSdk({
      pinnedOrder: ["a", "b", "c"],
      deferRpc: ["pinnedOrder"],
    });
    const { result } = renderHook(() => usePinnedOrder());

    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["a", "b", "c"] }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    // A read goes out and stalls, still carrying the pre-move order.
    act(() => void result.current.refresh());

    // The move answers first, with bb's new canonical order.
    setFakePinnedOrder(["b", "a", "c"]);
    act(() => result.current.move("b", null, "a"));
    await waitFor(() => expect(result.current.ids).toEqual(["b", "a", "c"]));

    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["a", "b", "c"] }),
    );
    expect(result.current.ids).toEqual(["b", "a", "c"]);
  });

  it("re-reads rather than guessing when a move is rejected", async () => {
    configureFakeSdk({
      pinnedOrder: ["a", "b"],
      failMovePinned: true,
    });
    const { result } = renderHook(() => usePinnedOrder());
    await waitFor(() => expect(result.current.ids).toEqual(["a", "b"]));

    setFakePinnedOrder(["b", "a"]);
    act(() => result.current.move("b", null, "a"));

    // The refetch wins, so the list shows what bb actually has — not the
    // order the failed move asked for.
    await waitFor(() => expect(result.current.ids).toEqual(["b", "a"]));
  });

  it("re-enables moves after both the rejected move and failed refetch settle", async () => {
    configureFakeSdk({
      pinnedOrder: ["a", "b", "c"],
      deferRpc: ["pinnedOrder", "movePinned"],
    });
    const { result } = renderHook(() => usePinnedOrder());

    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["a", "b", "c"] }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.move("b", "c", null));
    expect(result.current.moving).toBe(true);
    act(() => result.current.move("c", "b", null));
    expect(rpcCalls.filter((call) => call.method === "movePinned")).toHaveLength(
      1,
    );

    await act(async () =>
      rejectPendingRpc("movePinned", "oldest", new Error("move failed")),
    );
    await waitFor(() =>
      expect(
        rpcCalls.filter((call) => call.method === "pinnedOrder"),
      ).toHaveLength(2),
    );
    await act(async () =>
      rejectPendingRpc("pinnedOrder", "oldest", new Error("refresh failed")),
    );
    await waitFor(() => expect(result.current.moving).toBe(false));

    act(() => result.current.move("c", "b", null));
    expect(rpcCalls.filter((call) => call.method === "movePinned")).toHaveLength(
      2,
    );
    await act(async () =>
      resolvePendingRpc("movePinned", "oldest", { ids: ["a", "b", "c"] }),
    );
  });

  it("runs a refresh requested during a successful move after its response", async () => {
    configureFakeSdk({
      pinnedOrder: ["a", "b"],
      deferRpc: ["pinnedOrder", "movePinned"],
    });
    const { result } = renderHook(() => usePinnedOrder());

    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["a", "b"] }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.move("b", null, "a"));
    act(() => void result.current.refresh());
    expect(rpcCalls.filter((call) => call.method === "pinnedOrder")).toHaveLength(
      1,
    );

    await act(async () =>
      resolvePendingRpc("movePinned", "oldest", { ids: ["b", "a"] }),
    );
    await waitFor(() =>
      expect(
        rpcCalls.filter((call) => call.method === "pinnedOrder"),
      ).toHaveLength(2),
    );
    expect(result.current.moving).toBe(true);

    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["new", "b", "a"] }),
    );
    await waitFor(() => expect(result.current.moving).toBe(false));
    expect(result.current.ids).toEqual(["new", "b", "a"]);
  });

  it("runs a refresh requested during a failed move after recovery", async () => {
    configureFakeSdk({
      pinnedOrder: ["a", "b"],
      deferRpc: ["pinnedOrder", "movePinned"],
    });
    const { result } = renderHook(() => usePinnedOrder());

    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["a", "b"] }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.move("b", null, "a"));
    act(() => void result.current.refresh());
    await act(async () =>
      rejectPendingRpc("movePinned", "oldest", new Error("move failed")),
    );
    await waitFor(() =>
      expect(
        rpcCalls.filter((call) => call.method === "pinnedOrder"),
      ).toHaveLength(2),
    );

    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["b", "a"] }),
    );
    await waitFor(() =>
      expect(
        rpcCalls.filter((call) => call.method === "pinnedOrder"),
      ).toHaveLength(3),
    );
    expect(result.current.moving).toBe(true);

    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["new", "b", "a"] }),
    );
    await waitFor(() => expect(result.current.moving).toBe(false));
    expect(result.current.ids).toEqual(["new", "b", "a"]);
  });

  it("keeps the gate locked while refreshes coalesce without dropping a later request", async () => {
    configureFakeSdk({
      pinnedOrder: ["a", "b"],
      deferRpc: ["pinnedOrder", "movePinned"],
    });
    const { result } = renderHook(() => usePinnedOrder());

    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["a", "b"] }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.move("b", null, "a"));
    act(() => {
      void result.current.refresh();
      void result.current.refresh();
      void result.current.refresh();
    });
    await act(async () =>
      resolvePendingRpc("movePinned", "oldest", { ids: ["b", "a"] }),
    );
    await waitFor(() =>
      expect(
        rpcCalls.filter((call) => call.method === "pinnedOrder"),
      ).toHaveLength(2),
    );
    expect(result.current.moving).toBe(true);

    // Requests arriving during the reconciliation read coalesce behind it.
    act(() => {
      void result.current.refresh();
      void result.current.refresh();
    });
    expect(rpcCalls.filter((call) => call.method === "pinnedOrder")).toHaveLength(
      2,
    );
    await act(async () =>
      resolvePendingRpc("pinnedOrder", "oldest", { ids: ["b", "a"] }),
    );
    await waitFor(() =>
      expect(
        rpcCalls.filter((call) => call.method === "pinnedOrder"),
      ).toHaveLength(3),
    );
    expect(result.current.moving).toBe(true);
    await act(async () =>
      resolvePendingRpc("pinnedOrder", "newest", {
        ids: ["new", "b", "a"],
      }),
    );
    await waitFor(() => expect(result.current.moving).toBe(false));
    expect(result.current.ids).toEqual(["new", "b", "a"]);
  });
});
