// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { configureFakeSdk, resolvePendingRpc } from "@/test/sdk-fake";
import { useSettledOverrides } from "./use-settled";

afterEach(cleanup);

const rows = (threadId: string) => ({
  rows: [{ threadId, override: "settled" as const, at: 1 }],
});

describe("useSettledOverrides request sequencing", () => {
  // The seq guard is the only thing standing between the user and a settle
  // that visibly undoes itself, so it gets a test of its own.
  it("ignores a read that was already in flight when a newer one landed", async () => {
    configureFakeSdk({ deferRpc: ["listOverrides"] });
    const { result } = renderHook(() => useSettledOverrides());

    // The mount read lands empty: nothing is settled yet.
    await act(async () => resolvePendingRpc("listOverrides", "oldest", { rows: [] }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // A refresh goes out and stalls — this is the read that will come back
    // stale, still describing the world before the settle.
    act(() => void result.current.refresh());

    // The settle happens, and the refresh it triggers answers first.
    act(() => void result.current.refresh());
    await act(async () =>
      resolvePendingRpc("listOverrides", "newest", rows("thr_a")),
    );
    expect([...result.current.overrides.keys()]).toEqual(["thr_a"]);

    // The stalled read finally answers with the pre-settle world. Applying it
    // would drop the thread straight back into the Inbox.
    await act(async () =>
      resolvePendingRpc("listOverrides", "oldest", { rows: [] }),
    );
    expect([...result.current.overrides.keys()]).toEqual(["thr_a"]);
  });

  it("keeps serving the last good list when a refresh fails", async () => {
    configureFakeSdk({ deferRpc: ["listOverrides"] });
    const { result } = renderHook(() => useSettledOverrides());

    await act(async () =>
      resolvePendingRpc("listOverrides", "oldest", rows("thr_a")),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    configureFakeSdk({ failRpc: true });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status).toBe("error");
    expect([...result.current.overrides.keys()]).toEqual(["thr_a"]);
  });
});
