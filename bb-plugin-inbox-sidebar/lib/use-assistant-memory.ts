import { useRpc } from "@get-bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import { useLiveRead } from "@/lib/use-live-read";

/** identity → latest memory warning, for assistants with memory. */
export function useAssistantMemoryWarnings(): ReadonlyMap<string, string> {
  const rpc = useRpc<typeof boardRpcContract>();
  const [warnings] = useLiveRead<ReadonlyMap<string, string>>(
    "assistant-memory",
    async () =>
      new Map(
        (await rpc.call("assistantMemory", {})).rows.flatMap((row) =>
          row.warning ? [[row.identity, row.warning] as const] : [],
        ),
      ),
    new Map(),
  );
  return warnings;
}
