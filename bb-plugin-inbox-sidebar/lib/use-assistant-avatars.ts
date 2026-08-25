import { useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";

/**
 * environmentId → img-ready data URL for each assistant home that has an
 * `avatar.svg`. Read-only and best-effort: any failure just means the rows
 * keep their initials.
 */
export function useAssistantAvatars(
  environmentIds: readonly string[],
): ReadonlyMap<string, string> {
  const rpc = useRpc<typeof boardRpcContract>();
  const [avatars, setAvatars] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const key = [...environmentIds].sort().join(",");
  useEffect(() => {
    if (!key) {
      setAvatars(new Map());
      return;
    }
    let live = true;
    void rpc
      .call("listAssistantAvatars", { environmentIds: key.split(",") })
      .then((result) => {
        if (!live) return;
        setAvatars(
          new Map(
            result.rows.map((row) => [
              row.environmentId,
              `data:image/svg+xml;utf8,${encodeURIComponent(row.svg)}`,
            ]),
          ),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, rpc]);

  return avatars;
}
