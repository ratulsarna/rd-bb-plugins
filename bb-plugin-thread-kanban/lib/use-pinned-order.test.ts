// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  configureFakeSdk,
  resolvePendingRpc,
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
});
