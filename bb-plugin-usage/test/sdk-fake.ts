import { useEffect, useSyncExternalStore, type ComponentType } from "react";

type RpcHandler = (input: unknown) => unknown | Promise<unknown>;

interface NavPanelRegistration {
  id: string;
  title: string;
  icon: string;
  path: string;
  component: ComponentType<{ subPath: string }>;
  headerContent?: ComponentType<{ subPath: string }>;
}

export const registrations = {
  navPanels: [] as NavPanelRegistration[],
};

export const rpcCalls: Array<{ method: string; input: unknown }> = [];

let rpcHandler: RpcHandler = () => {
  throw new Error("No getUsage handler configured");
};

const rpc = {
  call(method: string, input: unknown) {
    rpcCalls.push({ method, input });
    return Promise.resolve(rpcHandler(input));
  },
};

type ConnectionState = "connecting" | "connected" | "reconnecting";
let connectionState: ConnectionState = "connected";
const connectionListeners = new Set<() => void>();

const realtimeHandlers = new Map<string, Set<(payload: unknown) => void>>();

export function configureFakeSdk({
  getUsage,
  connection = "connected",
}: {
  getUsage: RpcHandler;
  connection?: ConnectionState;
}) {
  rpcHandler = getUsage;
  connectionState = connection;
  rpcCalls.length = 0;
  realtimeHandlers.clear();
}

export function emitRealtime(channel: string, payload: unknown = {}) {
  for (const handler of realtimeHandlers.get(channel) ?? []) handler(payload);
}

export function setRealtimeConnectionState(next: ConnectionState) {
  connectionState = next;
  for (const listener of connectionListeners) listener();
}

export function definePluginApp(
  setup: (app: {
    slots: { navPanel(registration: NavPanelRegistration): void };
  }) => void,
) {
  setup({
    slots: {
      navPanel: (registration) => registrations.navPanels.push(registration),
    },
  });
  return registrations;
}

export const useRpc = () => rpc;

export function useRealtime(
  channel: string,
  handler: (payload: unknown) => void,
) {
  useEffect(() => {
    const handlers = realtimeHandlers.get(channel) ?? new Set();
    handlers.add(handler);
    realtimeHandlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (!handlers.size) realtimeHandlers.delete(channel);
    };
  }, [channel, handler]);
}

export function useRealtimeConnectionState() {
  return useSyncExternalStore(
    (listener) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    () => connectionState,
    () => connectionState,
  );
}
