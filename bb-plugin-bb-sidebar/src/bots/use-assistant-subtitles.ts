import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { botsRpcContract } from "./contract";
import { BOTS_SUBTITLES_CHANNEL } from "./channels";
import { shouldRefreshOnReconnect } from "./reconnect";

export interface AssistantSubtitlesApi {
  /** environmentId → subtitle, from the plugin's own store. */
  subtitles: ReadonlyMap<string, string>;
  /** Empty string clears the subtitle. A failed write toasts and re-reads. */
  set(threadId: string, subtitle: string): void;
}

export function useAssistantSubtitles(): AssistantSubtitlesApi {
  const rpc = useRpc<typeof botsRpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [subtitles, setSubtitles] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  // Responses can land out of order (a mutation's refresh racing a realtime
  // one); only the newest request may write.
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("listAssistantSubtitles", {});
      if (seq !== requestSeq.current) return;
      setSubtitles(
        new Map(result.rows.map((row) => [row.environmentId, row.subtitle])),
      );
    } catch {
      // Reads are best-effort: rows simply show no subtitle.
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Every mutation publishes here, so one subscription refreshes all clients.
  useRealtime(BOTS_SUBTITLES_CHANNEL, () => {
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

  return useMemo<AssistantSubtitlesApi>(
    () => ({
      subtitles,
      set: (threadId, subtitle) =>
        void rpc
          .call("setAssistantSubtitle", { threadId, subtitle })
          .catch(() => {
            toast.error("Could not save subtitle");
            void refresh();
          }),
    }),
    [refresh, rpc, subtitles],
  );
}
