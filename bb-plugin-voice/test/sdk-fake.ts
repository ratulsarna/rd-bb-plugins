import { useEffect, useSyncExternalStore, type ComponentType } from "react";

type RpcHandler = (method: string, input: unknown) => unknown | Promise<unknown>;

interface HeaderActionRegistration {
  id: string;
  title: string;
  component: ComponentType<{
    threadId: string;
    projectId: string;
    isCompactViewport: boolean;
  }>;
}

export const registrations = {
  threadHeaderActions: [] as HeaderActionRegistration[],
};

export const rpcCalls: Array<{ method: string; input: unknown }> = [];

let rpcHandler: RpcHandler = () => {
  throw new Error("No RPC handler configured");
};

const rpc = {
  call(method: string, input: unknown) {
    rpcCalls.push({ method, input });
    return Promise.resolve(rpcHandler(method, input));
  },
};

type ConnectionState = "connecting" | "connected" | "reconnecting";
let connectionState: ConnectionState = "connected";
const connectionListeners = new Set<() => void>();
const realtimeHandlers = new Map<string, Set<(payload: unknown) => void>>();

export function configureFakeSdk({
  handler,
  connection = "connected",
}: {
  handler: RpcHandler;
  connection?: ConnectionState;
}) {
  rpcHandler = handler;
  connectionState = connection;
  rpcCalls.length = 0;
  realtimeHandlers.clear();
}

export function setRealtimeConnectionState(next: ConnectionState) {
  connectionState = next;
  for (const listener of connectionListeners) listener();
}

export function emitRealtime(channel: string, payload: unknown = {}) {
  for (const handler of realtimeHandlers.get(channel) ?? []) handler(payload);
}

export function definePluginApp(
  setup: (app: {
    slots: {
      experimental_threadHeaderAction(
        registration: HeaderActionRegistration,
      ): void;
    };
  }) => void,
) {
  setup({
    slots: {
      experimental_threadHeaderAction: (registration) =>
        registrations.threadHeaderActions.push(registration),
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
