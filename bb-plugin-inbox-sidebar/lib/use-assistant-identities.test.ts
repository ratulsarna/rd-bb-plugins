// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  configureFakeSdk,
  resolvePendingRpc,
  rpcCalls,
} from "@/test/sdk-fake";
import { useAssistantIdentities } from "./use-assistant-identities";

afterEach(cleanup);

describe("useAssistantIdentities", () => {
  it("deduplicates and batches a duplicate-heavy fleet within rpc limits", async () => {
    // 260 entries over 150 distinct environments, like a fleet where every
    // automation run shares its assistant's environment.
    const unique = Array.from({ length: 150 }, (_, i) => `env-${i}`);
    const ids = [...unique, ...unique.slice(0, 110)];
    configureFakeSdk({ assistantIdentities: { "env-1": "proj_x:sam" } });

    const { result } = renderHook(() => useAssistantIdentities(ids));
    await waitFor(() => expect(result.current.ready).toBe(true));

    const calls = rpcCalls.filter(
      (call) => call.method === "assistantIdentities",
    );
    // Every call stays inside the contract's cap, and no id is sent twice —
    // duplicates would trip the cap and lose every key at once.
    expect(
      calls.every(
        (call) =>
          (call.input as { environmentIds: string[] }).environmentIds.length <=
          100,
      ),
    ).toBe(true);
    const sent = calls.flatMap(
      (call) => (call.input as { environmentIds: string[] }).environmentIds,
    );
    expect(sent).toHaveLength(150);
    expect(new Set(sent).size).toBe(150);

    expect(result.current.identities.get("env-1")).toBe("proj_x:sam");
    expect(result.current.identities.get("env-2")).toBe("env-2");
  });

  it("is not ready until every requested id resolves", async () => {
    configureFakeSdk({
      deferRpc: ["assistantIdentities"],
      assistantIdentities: { "env-a": "proj_x:sam" },
    });
    const { result } = renderHook(() =>
      useAssistantIdentities(["env-a", "env-b"]),
    );
    expect(result.current.ready).toBe(false);

    await act(async () =>
      resolvePendingRpc("assistantIdentities", "oldest", {
        rows: [
          { environmentId: "env-a", identity: "proj_x:sam" },
          { environmentId: "env-b", identity: "env-b" },
        ],
      }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.identities.get("env-a")).toBe("proj_x:sam");
  });

  it("loses readiness when a new row's identity is not known yet", async () => {
    configureFakeSdk({});
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useAssistantIdentities(ids),
      { initialProps: { ids: ["env-a"] } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    // A fresh environment appears (a reattached thread); the next read has
    // not landed, so moves must not run against a half-known map.
    rerender({ ids: ["env-a", "env-new"] });
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.identities.get("env-new")).toBe("env-new");
  });

  it("stays unresolved when the read fails, and recovers on the next read", async () => {
    configureFakeSdk({ failRpc: true });
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useAssistantIdentities(ids),
      { initialProps: { ids: ["env-a"] } },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.ready).toBe(false);
    expect(result.current.identities.size).toBe(0);

    // The failure clears; a changed row set re-reads and readiness returns.
    configureFakeSdk({ failRpc: false, assistantIdentities: { "env-a": "proj_x:sam" } });
    rerender({ ids: ["env-a", "env-b"] });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.identities.get("env-a")).toBe("proj_x:sam");
  });

  it("re-reads after a reconnect when the first read failed", async () => {
    configureFakeSdk({ failRpc: true });
    const { result, rerender } = renderHook(() =>
      useAssistantIdentities(["env-a"]),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.ready).toBe(false);

    // The same environments, unchanged rows: only the connection dropping
    // and returning gives the read another chance — no remount needed.
    configureFakeSdk({
      failRpc: false,
      connectionState: "reconnecting",
      assistantIdentities: { "env-a": "proj_x:sam" },
    });
    rerender();
    configureFakeSdk({
      failRpc: false,
      connectionState: "connected",
      assistantIdentities: { "env-a": "proj_x:sam" },
    });
    rerender();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.identities.get("env-a")).toBe("proj_x:sam");
  });
});
