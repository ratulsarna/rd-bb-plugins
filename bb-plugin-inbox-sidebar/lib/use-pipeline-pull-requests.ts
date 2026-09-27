import { useEffect, useState } from "react";
import {
  useRpc,
  useRealtimeConnectionState,
  type PluginSidebarPullRequest,
} from "@bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import type { BoardThread } from "./lanes";

export function usePipelinePullRequests(threads: readonly BoardThread[]) {
  const rpc = useRpc<typeof boardRpcContract>();
  const connectionState = useRealtimeConnectionState();
  const idsKey = JSON.stringify(
    threads.filter((thread) => !thread.isArchived).map((thread) => thread.id).sort(),
  );
  const [pullRequests, setPullRequests] = useState<
    ReadonlyMap<string, PluginSidebarPullRequest | null>
  >(() => new Map());

  useEffect(() => {
    const ids: string[] = JSON.parse(idsKey);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const next = new Map<string, PluginSidebarPullRequest | null>();
      for (let offset = 0; offset < ids.length && !disposed; offset += 100) {
        try {
          const { rows } = await rpc.call("threadPullRequests", {
            threadIds: ids.slice(offset, offset + 100),
          });
          for (const { threadId, pullRequest } of rows) {
            next.set(threadId, pullRequest === null ? null : {
              ...pullRequest, attention: "none",
            });
          }
        } catch {
          // A failed batch cannot provide a reliable task association.
        }
      }
      if (disposed) return;
      setPullRequests(next);
      if (ids.length > 0) timer = setTimeout(refresh, 30_000);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [rpc, connectionState, idsKey]);

  return pullRequests;
}
