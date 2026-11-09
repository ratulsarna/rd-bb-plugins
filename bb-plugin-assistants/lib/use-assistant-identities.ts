import { useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { assistantRpcContract } from "@/server";
import { shouldRefreshOnReconnect } from "inbox-core/lib/reconnect";

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
  /** True once the read for the current rows has answered or failed, or there is nothing to read. */
  loaded: boolean;
}

/**
 * environmentId → stable assistant identity for each of the board's rows.
 * Final non-home answers use their environment id. Unresolved lookups reject
 * so transient fallback keys never enable reordering.
 */
export function useAssistantIdentities(
  environmentIds: readonly string[],
): AssistantIdentitiesApi {
  const rpc = useRpc<typeof assistantRpcContract>();
  // Kept across re-reads: an identity doesn't change, so the rows keep their
  // order and hidden state while a new row's identity is read.
  const [identities, setIdentities] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [answered, setAnswered] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
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

  const read = `${key}#${attempt}`;

  useEffect(() => {
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
        setAnswered(`${key}#${attempt}`);
        setSettled(`${key}#${attempt}`);
      })
      .catch(() => {
        // Best-effort for display; readiness stays false so no move can
        // rewrite the stored order under environment-id keys.
        if (live) setSettled(`${key}#${attempt}`);
      });
    return () => {
      live = false;
    };
  }, [key, attempt, rpc]);

  const ready = useMemo(
    () =>
      key === "" ||
      (answered === read && key.split(",").every((id) => identities.has(id))),
    [answered, identities, key, read],
  );
  const loaded = key === "" || settled === read;

  return useMemo(
    () => ({ identities, ready, loaded }),
    [identities, loaded, ready],
  );
}
