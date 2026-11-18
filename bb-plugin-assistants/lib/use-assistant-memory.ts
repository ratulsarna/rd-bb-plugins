import { useRpc } from "@get-bb/plugin-sdk/app";
import type { assistantRpcContract } from "@/server";
import { useLiveRead } from "@/lib/use-live-read";

export interface AssistantMemoryRow {
  /** Latest memory warning. */
  warning: string | null;
  /** The main chat while memory is on. */
  main: string | null;
}

/** identity → memory state, for assistants that have had memory. */
export function useAssistantMemory(): ReadonlyMap<string, AssistantMemoryRow> {
  const rpc = useRpc<typeof assistantRpcContract>();
  const [rows] = useLiveRead<ReadonlyMap<string, AssistantMemoryRow>>(
    "assistant-memory",
    async () =>
      new Map(
        (await rpc.call("assistantMemory", {})).rows.map(({ identity, warning, main }) => [identity, { warning, main }] as const),
      ),
    new Map(),
  );
  return rows;
}
