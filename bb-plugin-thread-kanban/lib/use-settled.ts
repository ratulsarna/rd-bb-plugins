import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import type { SettledOverride } from "@/lib/lanes";
import { shouldRefreshOnReconnect } from "@/lib/reconnect";

export interface SettledApi {
  /** threadId → override, from the plugin's own store. */
  overrides: ReadonlyMap<string, SettledOverride>;
  /** Reads only. A failed write toasts instead of blanking the board. */
  status: "loading" | "ready" | "error";
  refresh(): Promise<void>;
  settle(threadId: string): void;
  unsettle(threadId: string): void;
}

export function useSettledOverrides(): SettledApi {
  const rpc = useRpc<typeof boardRpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [overrides, setOverrides] = useState<
    ReadonlyMap<string, SettledOverride>
  >(() => new Map());
  const [status, setStatus] = useState<SettledApi["status"]>("loading");

  // Responses can land out of order (a mutation's refresh racing a realtime
  // one), and an older list would silently restore state the user just
  // changed. Only the newest request may write.
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const result = await rpc.call("listOverrides", {});
      if (seq !== requestSeq.current) return;
      setOverrides(
        new Map(
          result.rows.map((row) => [
            row.threadId,
            { override: row.override, at: row.at },
          ]),
        ),
      );
      setStatus("ready");
    } catch {
      if (seq === requestSeq.current) setStatus("error");
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Every mutation publishes here, so one subscription refreshes all clients.
  useRealtime("settled", () => {
    void refresh();
  });

  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (shouldRefreshOnReconnect(previous, connectionState)) {
      void refresh();
    }
  }, [connectionState, refresh]);

  return useMemo<SettledApi>(
    () => ({
      overrides,
      status,
      refresh,
      // A failed write is about one thread, not the board: toast it and
      // re-read, so the row snaps back to the truth. Flipping `status` here
      // would replace the whole list with an error screen.
      settle: (threadId) =>
        void rpc.call("settle", { threadId }).catch(() => {
          toast.error("Could not settle thread");
          void refresh();
        }),
      unsettle: (threadId) =>
        void rpc.call("unsettle", { threadId }).catch(() => {
          toast.error("Could not unsettle thread");
          void refresh();
        }),
    }),
    [overrides, refresh, rpc, status],
  );
}
