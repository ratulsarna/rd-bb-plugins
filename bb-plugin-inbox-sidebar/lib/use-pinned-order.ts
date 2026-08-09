import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import { shouldRefreshOnReconnect } from "@/lib/reconnect";

export interface PinnedOrderApi {
  /** bb's pinned-root order, freshest known. */
  ids: readonly string[];
  /** False until the first read lands. Move controls stay disabled until it. */
  ready: boolean;
  /** True until BB answers the current move and any queued refresh finishes. */
  moving: boolean;
  /** Re-read bb's order; requests during a move coalesce behind it. */
  refresh(): Promise<void>;
  move(
    threadId: string,
    previousThreadId: string | null,
    nextThreadId: string | null,
  ): void;
}

/**
 * The pinned order, read from and written through bb.
 *
 * bb owns this order — the plugin stores nothing. A move's response is the
 * canonical list, so it is applied directly; a failed move re-reads rather
 * than guessing, because a wrong local order would survive until the next
 * unrelated refresh.
 */
export function usePinnedOrder(): PinnedOrderApi {
  const rpc = useRpc<typeof boardRpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [ids, setIds] = useState<readonly string[]>(() => []);
  const [ready, setReady] = useState(false);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const refreshPendingRef = useRef(false);

  // One counter across reads and writes: a list read that was already in
  // flight when the user moved a thread must not land on top of the move.
  const requestSeq = useRef(0);
  const readOrder = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("pinnedOrder", {});
      if (seq !== requestSeq.current) return;
      setIds(result.ids);
      setReady(true);
    } catch {
      // Leave `ready` alone: an unknown order disables reordering, and the
      // board itself still renders with its fallback pin sort.
    }
  }, [rpc]);

  const finishMove = useCallback(async () => {
    while (refreshPendingRef.current) {
      refreshPendingRef.current = false;
      await readOrder();
    }
    movingRef.current = false;
    setMoving(false);
  }, [readOrder]);

  const refresh = useCallback(async () => {
    if (movingRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    await readOrder();
  }, [readOrder]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("pinned-order", () => {
    void refresh();
  });

  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (shouldRefreshOnReconnect(previous, connectionState)) void refresh();
  }, [connectionState, refresh]);

  const move = useCallback<PinnedOrderApi["move"]>(
    (threadId, previousThreadId, nextThreadId) => {
      if (movingRef.current) return;
      movingRef.current = true;
      setMoving(true);
      const seq = ++requestSeq.current;
      void (async () => {
        try {
          const result = await rpc.call("movePinned", {
            threadId,
            previousThreadId,
            nextThreadId,
          });
          if (seq === requestSeq.current) setIds(result.ids);
        } catch {
          await readOrder();
        } finally {
          await finishMove();
        }
      })();
    },
    [finishMove, readOrder, rpc],
  );

  return useMemo(
    () => ({ ids, ready, moving, refresh, move }),
    [ids, move, moving, ready, refresh],
  );
}
