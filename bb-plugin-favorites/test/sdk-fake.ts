import {
  createElement,
  useEffect,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import type { NewThreadComposerProps } from "@bb/plugin-sdk/app";

type RpcHandler = (method: string, input: unknown) => unknown | Promise<unknown>;

interface NavPanelRegistration {
  id: string;
  title: string;
  icon: string;
  path: string;
  component: ComponentType<{ subPath: string }>;
}

export const registrations = {
  navPanels: [] as NavPanelRegistration[],
};

export const rpcCalls: Array<{ method: string; input: unknown }> = [];
export const navigateCalls: Array<{ kind: "thread"; threadId: string }> = [];
export const composerDrafts = new Map<string, string>();
export const lastComposerProps: {
  draftKey?: string;
  focusRequest?: number;
  layout?: NewThreadComposerProps["layout"];
} = {};

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

let context = { projectId: "proj_plugins", threadId: null as string | null };

export function configureFakeSdk({
  handler,
  projectId = "proj_plugins",
  connection = "connected",
}: {
  handler: RpcHandler;
  projectId?: string;
  connection?: ConnectionState;
}) {
  rpcHandler = handler;
  context = { projectId, threadId: null };
  connectionState = connection;
  rpcCalls.length = 0;
  navigateCalls.length = 0;
  lastComposerProps.draftKey = undefined;
  lastComposerProps.focusRequest = undefined;
  lastComposerProps.layout = undefined;
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

export function useBbContext() {
  return context;
}

export function useBbNavigate() {
  return {
    toThread(threadId: string) {
      navigateCalls.push({ kind: "thread", threadId });
    },
  };
}

export function experimental_NewThreadComposer(props: NewThreadComposerProps) {
  lastComposerProps.draftKey = props.draftKey;
  lastComposerProps.focusRequest = props.focusRequest;
  lastComposerProps.layout = props.layout;
  const draftKey = props.draftKey ?? "plugin-default";
  const draft = composerDrafts.get(draftKey) ?? "";
  return createElement(
    "div",
    { "data-testid": "new-thread-composer" },
    createElement("div", null, `project:${props.defaultProjectId ?? ""}`),
    createElement("div", null, `provider:${props.defaultProviderId ?? ""}`),
    createElement("div", null, `model:${props.defaultModel ?? ""}`),
    createElement(
      "div",
      null,
      `reasoning:${props.defaultReasoningLevel ?? ""}`,
    ),
    createElement("div", null, `speed:${props.defaultServiceTier ?? ""}`),
    createElement("div", null, `draftKey:${draftKey}`),
    createElement(
      "div",
      null,
      `environment:${
        props.defaultEnvironment
          ? JSON.stringify(props.defaultEnvironment)
          : ""
      }`,
    ),
    createElement("textarea", {
      "aria-label": "Prompt",
      defaultValue: draft,
      onChange: (event: { currentTarget: { value: string } }) => {
        composerDrafts.set(draftKey, event.currentTarget.value);
      },
    }),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          void props.onSubmit({
            projectId: props.defaultProjectId ?? "",
            providerId: props.defaultProviderId ?? "",
            model: props.defaultModel ?? "",
            reasoningLevel: props.defaultReasoningLevel ?? "medium",
            permissionMode: "auto",
            serviceTier: props.defaultServiceTier,
            executionInputSources: {
              providerId: "explicit",
              model: "explicit",
              reasoningLevel: "explicit",
              ...(props.defaultServiceTier
                ? { serviceTier: "explicit" as const }
                : {}),
            },
            environment:
              props.defaultEnvironment ?? { type: "project-default" },
            input: [{ type: "text", text: "hello", mentions: [] }],
          });
        },
      },
      "Start",
    ),
  );
}

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
