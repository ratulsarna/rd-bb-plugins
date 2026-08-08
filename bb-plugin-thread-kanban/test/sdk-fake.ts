import type { ComponentType } from "react";
import type {
  PluginSidebarProject,
  PluginSidebarPullRequest,
  PluginThreadListProps,
} from "@bb/plugin-sdk/app";
import type { BoardThread, SettledOverride } from "@/lib/lanes";

/**
 * A stand-in for `@bb/plugin-sdk/app`, aliased in by vitest.config.ts.
 *
 * The SDK is a runtime the bb app injects — the plugin only ever sees its
 * types — so component tests need something to import. This is the smallest
 * thing that satisfies the hooks this plugin actually calls.
 */
export interface FakeSdkConfig {
  threadStatus: "loading" | "ready" | "error";
  threads: BoardThread[];
  projects: PluginSidebarProject[];
  /** Reported by the PR probes; a missing key reports null. */
  pullRequests: Record<string, PluginSidebarPullRequest | null>;
  overrides: Array<{ threadId: string } & SettledOverride>;
  failRpc: boolean;
  /** What `pinnedOrder` returns; `setFakePinnedOrder` changes it mid-test. */
  pinnedOrder: string[];
  /** Makes `movePinned` reject, so the refetch path can be exercised. */
  failMovePinned: boolean;
  /** Makes `pinnedOrder` reject, leaving the order unknown. */
  failPinnedOrder: boolean;
}

const DEFAULTS: FakeSdkConfig = {
  threadStatus: "ready",
  threads: [],
  projects: [{ id: "project-1", name: "bb", isPersonal: false }],
  pullRequests: {},
  overrides: [],
  failRpc: false,
  pinnedOrder: [],
  failMovePinned: false,
  failPinnedOrder: false,
};

let config: FakeSdkConfig = DEFAULTS;

export interface SidebarActionCall {
  method: string;
  threadId: string;
  options?: unknown;
}

export const sidebarActionCalls: SidebarActionCall[] = [];
export const rpcCalls: Array<{ method: string; input: unknown }> = [];

export function configureFakeSdk(next: Partial<FakeSdkConfig> = {}): void {
  config = { ...DEFAULTS, ...next };
  sidebarActionCalls.length = 0;
  rpcCalls.length = 0;
}

/** Change what a later `pinnedOrder` read returns, mid-test. */
export function setFakePinnedOrder(ids: string[]): void {
  config.pinnedOrder = ids;
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

export const registrations = {
  navPanels: [] as Array<{ id: string }>,
  threadLists: [] as ThreadListRegistration[],
  threadHeaderActions: [] as Array<{ id: string }>,
};

export function definePluginApp(
  setup: (app: {
    slots: {
      navPanel(registration: { id: string }): void;
      experimental_threadList(registration: ThreadListRegistration): void;
      experimental_threadHeaderAction(registration: { id: string }): void;
    };
  }) => void,
): typeof registrations {
  setup({
    slots: {
      navPanel: (registration) => registrations.navPanels.push(registration),
      experimental_threadList: (registration) =>
        registrations.threadLists.push(registration),
      experimental_threadHeaderAction: (registration) =>
        registrations.threadHeaderActions.push(registration),
    },
  });
  return registrations;
}

// Stable identities: a hook that hands back a fresh object every render turns
// the board's memoized effects into an infinite loop.
const actions = {
  open: (threadId: string, options?: unknown) =>
    sidebarActionCalls.push({ method: "open", threadId, options }),
  openNewThread: () => {},
  setPinned: async (threadId: string, pinned: boolean) => {
    sidebarActionCalls.push({ method: "setPinned", threadId, options: pinned });
  },
  setRead: async (threadId: string, read: boolean) => {
    sidebarActionCalls.push({ method: "setRead", threadId, options: read });
  },
  rename: async () => {},
  archive: (threadId: string) =>
    sidebarActionCalls.push({ method: "archive", threadId }),
  requestDelete: (threadId: string) =>
    sidebarActionCalls.push({ method: "requestDelete", threadId }),
};

const rpc = {
  call: async (method: string, input: unknown) => {
    rpcCalls.push({ method, input });
    if (config.failRpc) throw new Error("rpc failed");
    if (method === "pinnedOrder") {
      if (config.failPinnedOrder) throw new Error("pinnedOrder failed");
      return { ids: config.pinnedOrder };
    }
    if (method === "movePinned") {
      if (config.failMovePinned) throw new Error("movePinned failed");
      // bb's answer is the canonical list; the fake just echoes what it has.
      return { ids: config.pinnedOrder };
    }
    if (method === "listOverrides") {
      return {
        rows: config.overrides.map((row) => ({
          threadId: row.threadId,
          override: row.override,
          at: row.at,
        })),
      };
    }
    return { ok: true };
  },
};

export const experimental_useSidebarThreads = () => ({
  status: config.threadStatus,
  threads: config.threads,
  projects: config.projects,
});

export const experimental_useSidebarThreadActions = () => actions;

export const experimental_useSidebarThreadPullRequest = (threadId: string) => ({
  isLoading: false,
  pullRequest: config.pullRequests[threadId] ?? null,
});

export const useRpc = () => rpc;

export const useRealtime = () => {};

export const useRealtimeConnectionState = () => "connected" as const;

export const useBbNavigate = () => ({ toPluginPanel: () => {} });
