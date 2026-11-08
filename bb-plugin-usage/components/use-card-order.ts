import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { CARD_ORDER_CHANNEL } from "../lib/card-order";
import type { rpcContract } from "../server";

/** The user's saved card order, shared by every device through the server. */
export function useCardOrder() {
  const rpc = useRpc<typeof rpcContract>();
  const [order, setOrder] = useState<readonly string[]>([]);
  // A read that started before a save must not undo it.
  const revision = useRef(0);

  const load = useCallback(async () => {
    const id = ++revision.current;
    try {
      const { order: saved } = await rpc.call("getCardOrder", {});
      if (id === revision.current) setOrder(saved);
    } catch {
      // Without a saved order the cards keep their default order.
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(CARD_ORDER_CHANNEL, load);

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") {
      void load();
    }
    previousConnection.current = connection;
  }, [connection, load]);

  const save = useCallback(
    async (next: readonly string[]) => {
      revision.current += 1;
      setOrder(next);
      try {
        await rpc.call("setCardOrder", { order: [...next] });
      } catch {
        await load();
      }
    },
    [load, rpc],
  );

  return { order, save };
}
