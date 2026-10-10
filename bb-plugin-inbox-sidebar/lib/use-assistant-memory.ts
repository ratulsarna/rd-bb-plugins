import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import { shouldRefreshOnReconnect } from "@/lib/reconnect";

/** identity → latest memory warning, for assistants with memory. */
export function useAssistantMemoryWarnings(): ReadonlyMap<string, string> {
  const rpc = useRpc<typeof boardRpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [warnings, setWarnings] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  // Only the newest read may write: a realtime refresh can race the first one.
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("assistantMemory", {});
      if (seq !== requestSeq.current) return;
      setWarnings(
        new Map(
          result.rows.flatMap((row) =>
            row.warning ? [[row.identity, row.warning] as const] : [],
          ),
        ),
      );
    } catch {
      // Best-effort: rows simply show no mark.
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("assistant-memory", () => {
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

  return warnings;
}
