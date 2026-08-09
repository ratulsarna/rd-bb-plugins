import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginRpcResult,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server";

export const AUTO_REFRESH_MS = 180_000;

export type UsageData = PluginRpcResult<(typeof rpcContract)["getUsage"]>;
export type ProviderUsage = UsageData["providers"][keyof UsageData["providers"]];
export type UsageWindow = ProviderUsage["windows"][number];

const usageListeners = new Set<(data: UsageData) => void>();

function publishLocalUsage(data: UsageData) {
  for (const listener of usageListeners) listener(data);
}

type UsageState =
  | { phase: "loading"; data: null }
  | { phase: "ready"; data: UsageData }
  | { phase: "error"; data: null };

export function useUsage({ realtime = false }: { realtime?: boolean } = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<UsageState>({ phase: "loading", data: null });
  const [manualPending, setManualPending] = useState(false);
  const [manualFailed, setManualFailed] = useState(false);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const dataRef = useRef<UsageData | null>(null);

  const applyUsage = useCallback((data: UsageData) => {
    const currentTimestamp = dataRef.current
      ? Date.parse(dataRef.current.fetchedAt)
      : Number.NEGATIVE_INFINITY;
    const nextTimestamp = Date.parse(data.fetchedAt);
    if (
      Number.isFinite(currentTimestamp) &&
      Number.isFinite(nextTimestamp) &&
      nextTimestamp < currentTimestamp
    ) {
      return false;
    }

    dataRef.current = data;
    requestId.current += 1;
    setState({ phase: "ready", data });
    setManualFailed(false);
    return true;
  }, []);

  const load = useCallback(
    async (refresh: boolean) => {
      const id = ++requestId.current;
      try {
        const data = await rpc.call(
          "getUsage",
          refresh ? { refresh: true } : {},
        );
        if (!mounted.current || id !== requestId.current) return undefined;
        if (!applyUsage(data)) return undefined;
        return data;
      } catch {
        if (!mounted.current || id !== requestId.current) return undefined;
        setState((current) =>
          current.data ? current : { phase: "error", data: null },
        );
        return null;
      }
    },
    [applyUsage, rpc],
  );

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    mounted.current = true;
    void loadRef.current(false);
    const timer = window.setInterval(
      () => void loadRef.current(false),
      AUTO_REFRESH_MS,
    );

    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!realtime) return;

    // Header and panel are separate React roots. This keeps a successful
    // manual refresh visible even when its realtime event is missed.
    usageListeners.add(applyUsage);
    return () => {
      usageListeners.delete(applyUsage);
    };
  }, [applyUsage, realtime]);

  const onUsageUpdated = useCallback(() => {
    if (realtime) void loadRef.current(false);
  }, [realtime]);
  useRealtime("usage-updated", onUsageUpdated);

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (
      previousConnection.current === "reconnecting" &&
      connection === "connected"
    ) {
      void loadRef.current(false);
    }
    previousConnection.current = connection;
  }, [connection]);

  const refresh = useCallback(async () => {
    setManualPending(true);
    setManualFailed(false);
    try {
      const data = await loadRef.current(true);
      if (data) {
        publishLocalUsage(data);
      } else if (data === null && mounted.current) {
        setManualFailed(true);
      }
    } finally {
      if (mounted.current) setManualPending(false);
    }
  }, []);

  return { state, manualPending, manualFailed, refresh };
}
