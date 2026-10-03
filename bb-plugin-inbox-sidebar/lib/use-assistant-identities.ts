import { useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import { shouldRefreshOnReconnect } from "@/lib/reconnect";

/** The rpc takes at most 100 environment ids per call. */
const BATCH_SIZE = 100;

export interface AssistantIdentitiesApi {
  /** environmentId → stable assistant identity, fallback id when none. */
  identities: ReadonlyMap<string, string>;
  /**
   * True once every requested id is resolved. Moves stay disabled until it,
   * so a drag can never write environment-id keys over the saved order; a
   * failed read keeps it false rather than guessing.
   */
  ready: boolean;
}

/**
 * environmentId → stable assistant identity for each of the board's rows.
 * Final non-home answers use their environment id. Unresolved lookups reject
 * so transient fallback keys never enable reordering.
 */
export function useAssistantIdentities(
  environmentIds: readonly string[],
): AssistantIdentitiesApi {
  const rpc = useRpc<typeof boardRpcContract>();
  const [identities, setIdentities] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  // A failed read must not strand the section until a remount: a reconnect
  // bumps the attempt, re-running the read over the same environments.
  const [attempt, setAttempt] = useState(0);
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (shouldRefreshOnReconnect(previous, connectionState)) {
      setAttempt((current) => current + 1);
    }
  }, [connectionState]);

  const key = useMemo(
    () => [...new Set(environmentIds)].sort().join(","),
    [environmentIds],
  );

  useEffect(() => {
    setIdentities(new Map());
    if (key === "") {
      return;
    }
    const ids = key.split(",");
    let live = true;
    const batches: string[][] = [];
    for (let at = 0; at < ids.length; at += BATCH_SIZE) {
      batches.push(ids.slice(at, at + BATCH_SIZE));
    }
    void Promise.all(
      batches.map((batch) =>
        rpc.call("assistantIdentities", { environmentIds: batch }),
      ),
    )
      .then((results) => {
        if (!live) return;
        setIdentities(
          new Map(
            results
              .flatMap((result) => result.rows)
              .map((row) => [row.environmentId, row.identity]),
          ),
        );
      })
      .catch(() => {
        // Best-effort for display; readiness stays false so no move can
        // rewrite the stored order under environment-id keys.
      });
    return () => {
      live = false;
    };
  }, [key, attempt, rpc]);

  const ready = useMemo(
    () => key === "" || key.split(",").every((id) => identities.has(id)),
    [identities, key],
  );

  return useMemo(
    () => ({ identities, ready }),
    [identities, ready],
  );
}
