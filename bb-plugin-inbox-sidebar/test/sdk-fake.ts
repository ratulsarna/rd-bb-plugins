import { createElement, useEffect, useState } from "react";
import type { NewThreadComposerProps, NewThreadRequest } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { assistantRpcContract } from "@/server";
import type { PipelinePullRequest } from "inbox-core/server";
import type { ComponentType } from "react";
import type {
  PluginRealtimeConnectionState,
  PluginSidebarProject,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { BoardThread } from "inbox-core/lib/lanes";
import { project } from "./fixtures";

/**
 * A stand-in for `@get-bb/plugin-sdk/app`, aliased in by vitest.config.ts.
 *
 * The SDK is a runtime the bb app injects — the plugin only ever sees its
 * types — so component tests need something to import. This is the smallest
 * thing that satisfies the hooks this plugin actually calls.
 */
export interface FakeSdkConfig {
  assistantSeeds: Record<string, z.infer<typeof assistantRpcContract.assistantSeeds.output>>;
  assistantDestinations: Record<string, z.infer<typeof assistantRpcContract.assistantDestination.output>>;
  composerRequest: NewThreadRequest | null;
  threads: BoardThread[];
  projects: PluginSidebarProject[];
  failRpc: boolean;
  /** What `assistantOrder` returns; `setAssistantOrder` echoes its input. */
  assistantOrder: string[];
  /** What `assistantIdentities` resolves; unmapped environments fall back to their id. */
  assistantIdentities: Record<string, string>;
  /** What `listAssistantSubtitles` returns; keyed by assistant identity. */
  subtitles: Array<{ identity: string; subtitle: string }>;
  /** What `assistantMemory` returns; keyed by assistant identity. */
  memoryWarnings: Array<{ identity: string; warning: string | null }>;
  /**
   * RPC methods to hold open. Calls land in `pendingRpc` for the test to
   * settle by hand — the only way to make two responses race on purpose.
   */
  deferRpc: string[];
  /** What `useRealtimeConnectionState` reports; flip mid-test to simulate a reconnect. */
  connectionState: PluginRealtimeConnectionState;
}

const DEFAULTS: FakeSdkConfig = {
  assistantSeeds: {}, assistantDestinations: {}, composerRequest: null,
  threads: [],
  projects: [project("project-1", "bb")],
  failRpc: false,
  assistantOrder: [],
  assistantIdentities: {},
  subtitles: [],
  memoryWarnings: [],
  deferRpc: [],
  connectionState: "connected",
};

let config: FakeSdkConfig = DEFAULTS;

export interface SidebarActionCall {
  method: string;
  threadId?: string;
  options?: unknown;
}

export const sidebarActionCalls: SidebarActionCall[] = [];
export const rpcCalls: Array<{ method: string; input: unknown }> = [];

export interface PendingRpc {
  method: string;
  input: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** Held-open calls for methods named in `deferRpc`, oldest first. */
export const pendingRpc: PendingRpc[] = [];

/**
 * Settle a held call. `position` picks which one, because racing two
 * responses is the whole point: "oldest" is the stale request, "newest" the
 * one the user just triggered.
 */
export function resolvePendingRpc(
  method: string,
  position: "oldest" | "newest",
  value: unknown,
): void {
  const matches = pendingRpc.filter((call) => call.method === method);
  const call = position === "oldest" ? matches[0] : matches[matches.length - 1];
  if (!call) throw new Error(`no pending ${method} call`);
  pendingRpc.splice(pendingRpc.indexOf(call), 1);
  call.resolve(value);
}

export function rejectPendingRpc(
  method: string,
  position: "oldest" | "newest",
  error: unknown,
): void {
  const matches = pendingRpc.filter((call) => call.method === method);
  const call =
    position === "oldest" ? matches[0] : matches[matches.length - 1];
  if (!call) throw new Error(`no pending ${method} call`);
  pendingRpc.splice(pendingRpc.indexOf(call), 1);
  call.reject(error);
}

export function configureFakeSdk(next: Partial<FakeSdkConfig> = {}): void {
  config = { ...DEFAULTS, ...next };
  sidebarActionCalls.length = 0;
  rpcCalls.length = 0;
  pendingRpc.length = 0;
  lastComposerProps = null;
  composerSubmitErrors.length = 0;
  composerDrafts.clear();
  navigateCalls.length = 0;
}

/** Change the live thread list mid-test; re-render to pick it up. */
export function setFakeThreads(threads: BoardThread[]): void {
  config.threads = threads;
}

interface ThreadListRegistration {
  id: string;
  title: string;
  description?: string;
  component: ComponentType<PluginThreadListProps>;
}

interface SidebarFooterActionRegistration {
  id: string;
  title: string;
  icon: string;
  run(): void;
}

interface ContentScriptRegistration {
  id: string;
  mount(context: { signal: AbortSignal }): void;
}

export const registrations = {
  threadLists: [] as ThreadListRegistration[],
  sidebarFooterActions: [] as SidebarFooterActionRegistration[],
  contentScripts: [] as ContentScriptRegistration[],
};

export function definePluginApp(
  setup: (app: {
    slots: {
      experimental_threadList(registration: ThreadListRegistration): void;
      sidebarFooterAction(registration: SidebarFooterActionRegistration): void;
    };
    contentScripts: {
      register(registration: ContentScriptRegistration): void;
    };
  }) => void,
): typeof registrations {
  setup({
    slots: {
      experimental_threadList: (registration) =>
        registrations.threadLists.push(registration),
      sidebarFooterAction: (registration) =>
        registrations.sidebarFooterActions.push(registration),
    },
    contentScripts: {
      register: (registration) =>
        registrations.contentScripts.push(registration),
    },
  });
  return registrations;
}

// Stable identities: a hook that hands back a fresh object every render turns
// the board's memoized effects into an infinite loop.
const actions = {
  open: (threadId: string, options?: unknown) =>
    sidebarActionCalls.push({ method: "open", threadId, options }),
  openNewThread: (options?: unknown) =>
    sidebarActionCalls.push({ method: "openNewThread", options }),
  setPinned: async (threadId: string, pinned: boolean) => {
    sidebarActionCalls.push({ method: "setPinned", threadId, options: pinned });
  },
  setRead: async (threadId: string, read: boolean) => {
    sidebarActionCalls.push({ method: "setRead", threadId, options: read });
  },
  rename: async (threadId: string, title: string) => {
    sidebarActionCalls.push({ method: "rename", threadId, options: title });
  },
  archive: (threadId: string) =>
    sidebarActionCalls.push({ method: "archive", threadId }),
  requestDelete: (threadId: string) =>
    sidebarActionCalls.push({ method: "requestDelete", threadId }),
};

const rpc = {
  call: async (method: string, input: unknown) => {
    rpcCalls.push({ method, input });
    if (config.failRpc) throw new Error("rpc failed");
    if (config.deferRpc.includes(method)) {
      return new Promise((resolve, reject) => {
        pendingRpc.push({ method, input, resolve, reject });
      });
    }
    if (method === "assistantSeeds") return config.assistantSeeds[(input as { threadId: string }).threadId];
    if (method === "assistantDestination") return config.assistantDestinations[(input as { hostId: string }).hostId];
    if (method === "createReplacementThread") return { newThreadId: "new-conversation" };
    // Fixed answers for the inbox RPCs core's board calls on render. The
    // board owns their behavior; the plugin's tests only need them to answer.
    if (method === "threadPullRequests") {
      const { threadIds } = input as { threadIds: string[] };
      return { rows: threadIds.map((threadId) => ({ threadId, pullRequest: null })) };
    }
    if (method === "pinnedOrder") {
      return { ids: [] };
    }
    if (method === "movePinned") {
      // bb's answer is the canonical list; the fake has none to echo.
      return { ids: [] };
    }
    if (method === "assistantOrder") {
      return { ids: config.assistantOrder };
    }
    if (method === "setAssistantOrder") {
      const { identities } = input as { identities: string[] };
      config.assistantOrder = identities;
      return { ids: identities };
    }
    if (method === "assistantIdentities") {
      const { environmentIds } = input as { environmentIds: string[] };
      return {
        rows: environmentIds.map((environmentId) => ({
          environmentId,
          identity: config.assistantIdentities[environmentId] ?? environmentId,
        })),
      };
    }
    if (method === "listAssistantSubtitles") {
      return { rows: config.subtitles };
    }
    if (method === "assistantMemory") {
      return { rows: config.memoryWarnings };
    }
    if (method === "listAssistantAvatars") {
      return { rows: [] };
    }
    if (method === "listOverrides") {
      return { rows: [] };
    }
    if (method === "projectCreationContext") {
      return {
        hosts: [{ id: "host-1", name: "Workstation" }],
        primaryHostId: "host-1",
      };
    }
    return { ok: true };
  },
};

export const experimental_useSidebarThreads = () => ({
  status: "ready" as const,
  threads: config.threads,
  projects: config.projects,
});

export const experimental_useSidebarThreadActions = () => actions;

export const experimental_useSidebarThreadSplit = () => ({
  splitProps: {},
});

export const useSidebarSplitLayout = () => null;

export const useRpc = () => rpc;

const realtimeHandlers = new Map<string, Set<() => void>>();

export const useRealtime = (channel: string, handler: () => void) => {
  useEffect(() => {
    const handlers = realtimeHandlers.get(channel) ?? new Set();
    handlers.add(handler);
    realtimeHandlers.set(channel, handlers);
    return () => void handlers.delete(handler);
  }, [channel, handler]);
};

/** Deliver a realtime publish to every mounted subscriber of `channel`. */
export function emitRealtime(channel: string): void {
  for (const handler of realtimeHandlers.get(channel) ?? []) handler();
}

export const useRealtimeConnectionState = () => config.connectionState;

export const navigateCalls: Array<{ method: string; arg: unknown }> = [];
const navigate = {
  toThread: (threadId: string) => {
    navigateCalls.push({ method: "toThread", arg: threadId });
  },
  toPluginPanel: (path: string, options?: unknown) => {
    navigateCalls.push({ method: "toPluginPanel", arg: { path, options } });
  },
};
export const useBbNavigate = () => navigate;

export let lastComposerProps: NewThreadComposerProps | null = null;
export const composerSubmitErrors: unknown[] = [];
const composerDrafts = new Map<string | undefined, string>();
export function experimental_NewThreadComposer(props: NewThreadComposerProps) {
  lastComposerProps = props;
  const [prompt, setPrompt] = useState(() => composerDrafts.get(props.draftKey) || props.initialPrompt || "");
  const [provider, setProvider] = useState(props.defaultProviderId ?? "codex");
  const [model, setModel] = useState(props.defaultModel ?? "destination-model");
  const seedKey = JSON.stringify([
    props.defaultProjectId, props.defaultProviderId, props.defaultModel,
    props.defaultReasoningLevel, props.defaultPermissionMode,
    props.defaultServiceTier, props.defaultEnvironment,
  ]);
  // The public composer compares seeds by value and keeps nonempty drafts.
  useEffect(() => {
    setProvider(props.defaultProviderId ?? "codex");
    setModel(props.defaultModel ?? "destination-model");
  }, [seedKey]);
  useEffect(() => {
    const draft = composerDrafts.get(props.draftKey) || props.initialPrompt || "";
    composerDrafts.set(props.draftKey, draft);
    setPrompt(draft);
  }, [props.draftKey, props.initialPrompt]);
  return createElement("div", {},
    createElement("textarea", {
      "aria-label": "Prompt", value: prompt,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        composerDrafts.set(props.draftKey, event.target.value);
        setPrompt(event.target.value);
      },
    }),
    createElement("input", { "aria-label": "Provider", value: provider,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setProvider(event.target.value) }),
    createElement("input", { "aria-label": "Model", value: model,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setModel(event.target.value) }),
    createElement("button", {
      type: "button", "aria-label": "Send conversation",
      onClick: () => {
        const request: NewThreadRequest = config.composerRequest ?? {
          projectId: props.defaultProjectId!, providerId: provider, model,
          reasoningLevel: "high", permissionMode: "full", executionInputSources: {},
          environment: props.defaultEnvironment!, input: [{ type: "text", text: prompt, mentions: [] }],
        };
        void Promise.resolve(props.onSubmit(request)).then(() => {
          composerDrafts.delete(props.draftKey);
          setPrompt("");
        }).catch((error) => composerSubmitErrors.push(error));
      },
    }, "Send"));
}
