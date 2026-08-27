import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import { shouldRefreshOnReconnect } from "@/lib/reconnect";

export interface AssistantOrderApi {
  /** The stored Bots order, freshest known. Environment ids. */
  ids: readonly string[];
  /** False until the first read lands. Reordering stays disabled until it. */
  ready: boolean;
  /** True until the server answers the current write. */
  moving: boolean;
  /** Store a full new order; the response is canonical. */
  set(environmentIds: readonly string[]): void;
}

/**
 * The Bots order, read from and written through the plugin's own store.
 *
 * A write's response is the canonical list, so it is applied directly; a
 * failed write re-reads rather than guessing, because a wrong local order
 * would survive until the next unrelated refresh.
 */
export function useAssistantOrder(): AssistantOrderApi {
  const rpc = useRpc<typeof boardRpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [ids, setIds] = useState<readonly string[]>(() => []);
  const [ready, setReady] = useState(false);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);

  // One counter across reads and writes: a list read already in flight when
  // the user drops a row must not land on top of the write's answer.
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("assistantOrder", {});
      if (seq !== requestSeq.current) return;
      setIds(result.ids);
      setReady(true);
    } catch {
      // Leave `ready` alone: an unknown order disables reordering, and the
      // section still renders in its activity fallback order.
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("assistant-order", () => {
    void refresh();
  });

  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (shouldRefreshOnReconnect(previous, connectionState)) void refresh();
  }, [connectionState, refresh]);

  const set = useCallback<AssistantOrderApi["set"]>(
    (environmentIds) => {
      if (movingRef.current) return;
      movingRef.current = true;
      setMoving(true);
      const seq = ++requestSeq.current;
      void (async () => {
        try {
          const result = await rpc.call("setAssistantOrder", {
            environmentIds: [...environmentIds],
          });
          if (seq === requestSeq.current) setIds(result.ids);
        } catch {
          await refresh();
        } finally {
          movingRef.current = false;
          setMoving(false);
        }
      })();
    },
    [refresh, rpc],
  );

  return useMemo(
    () => ({ ids, ready, moving, set }),
    [ids, moving, ready, set],
  );
}
