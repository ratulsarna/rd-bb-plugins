import { useMemo } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { assistantRpcContract } from "@/server";
import { useLiveRead } from "@/lib/use-live-read";

export interface AssistantHiddenApi {
  /** Identities of the bots that wait behind "Show more". */
  ids: ReadonlySet<string>;
  /** A failed write toasts and re-reads. */
  set(threadId: string, hidden: boolean): void;
}

export function useAssistantHidden(): AssistantHiddenApi {
  const rpc = useRpc<typeof assistantRpcContract>();
  const [ids, refresh] = useLiveRead<ReadonlySet<string>>(
    "assistant-hidden",
    async () => new Set((await rpc.call("hiddenAssistants", {})).ids),
    new Set(),
  );

  return useMemo<AssistantHiddenApi>(
    () => ({
      ids,
      set: (threadId, hidden) =>
        void rpc
          .call("setAssistantHidden", { threadId, hidden })
          .catch(() => {
            toast.error(hidden ? "Could not hide bot" : "Could not show bot");
            refresh();
          }),
    }),
    [ids, refresh, rpc],
  );
}
