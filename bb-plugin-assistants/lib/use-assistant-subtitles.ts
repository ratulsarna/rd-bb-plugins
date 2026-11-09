import { useMemo } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { assistantRpcContract } from "@/server";
import { useLiveRead } from "@/lib/use-live-read";

export interface AssistantSubtitlesApi {
  /** identity → subtitle, from the plugin's own store. */
  subtitles: ReadonlyMap<string, string>;
  /** True once the first read has answered or failed. */
  loaded: boolean;
  /** Empty string clears the subtitle. A failed write toasts and re-reads. */
  set(threadId: string, subtitle: string): void;
}

export function useAssistantSubtitles(): AssistantSubtitlesApi {
  const rpc = useRpc<typeof assistantRpcContract>();
  // Every mutation publishes on the channel, so one subscription refreshes all clients.
  const [subtitles, refresh, loaded] = useLiveRead<ReadonlyMap<string, string>>(
    "assistant-subtitles",
    async () =>
      new Map(
        (await rpc.call("listAssistantSubtitles", {})).rows.map((row) => [
          row.identity,
          row.subtitle,
        ]),
      ),
    new Map(),
  );

  return useMemo<AssistantSubtitlesApi>(
    () => ({
      subtitles,
      loaded,
      set: (threadId, subtitle) =>
        void rpc
          .call("setAssistantSubtitle", { threadId, subtitle })
          .catch(() => {
            toast.error("Could not save subtitle");
            refresh();
          }),
    }),
    [loaded, refresh, rpc, subtitles],
  );
}
