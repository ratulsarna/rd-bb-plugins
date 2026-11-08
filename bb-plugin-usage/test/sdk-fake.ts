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

/** getUsage calls; card-order calls go to `cardOrderCalls`. */
export const rpcCalls: Array<{ method: string; input: unknown }> = [];
export const cardOrderCalls: Array<{ method: string; input: unknown }> = [];

let rpcHandler: RpcHandler = () => {
  throw new Error("No getUsage handler configured");
};
/** The server's saved order; set it to simulate another device's save. */
export const savedCardOrder = { order: [] as string[], failSave: false };

const rpc = {
  call(method: string, input: unknown) {
    if (method === "getCardOrder" || method === "setCardOrder") {
      cardOrderCalls.push({ method, input });
      if (method === "getCardOrder") return Promise.resolve({ order: [...savedCardOrder.order] });
      if (savedCardOrder.failSave) return Promise.reject(new Error("save failed"));
      savedCardOrder.order = [...(input as { order: string[] }).order];
      return Promise.resolve({ order: [...savedCardOrder.order] });
    }
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
  cardOrderCalls.length = 0;
  savedCardOrder.order = [];
  savedCardOrder.failSave = false;
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
