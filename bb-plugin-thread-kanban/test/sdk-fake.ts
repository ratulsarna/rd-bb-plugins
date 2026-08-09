import type { ComponentType, PointerEvent as ReactPointerEvent } from "react";
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
  /**
   * RPC methods to hold open. Calls land in `pendingRpc` for the test to
   * settle by hand — the only way to make two responses race on purpose.
   */
  deferRpc: string[];
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
  deferRpc: [],
};

let config: FakeSdkConfig = DEFAULTS;

export interface SidebarActionCall {
  method: string;
  threadId: string;
  options?: unknown;
}

export const sidebarActionCalls: SidebarActionCall[] = [];
export const rpcCalls: Array<{ method: string; input: unknown }> = [];
export const splitPointerDownCalls: Array<{
  threadId: string;
  targetTitle: string | null;
  currentThreadId: string | null;
}> = [];

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
  splitPointerDownCalls.length = 0;
  pendingRpc.length = 0;
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
  threadLists: [] as ThreadListRegistration[],
};

export function definePluginApp(
  setup: (app: {
    slots: {
      experimental_threadList(registration: ThreadListRegistration): void;
    };
  }) => void,
): typeof registrations {
  setup({
    slots: {
      experimental_threadList: (registration) =>
        registrations.threadLists.push(registration),
    },
  });
  return registrations;
}

// Stable identities: a hook that hands back a fresh object every render turns
// the board's memoized effects into an infinite loop.
const actions = {
  open: (threadId: string, options?: unknown) =>
    sidebarActionCalls.push({ method: "open", threadId, options }),
  setPinned: async (threadId: string, pinned: boolean) => {
    sidebarActionCalls.push({ method: "setPinned", threadId, options: pinned });
  },
  setRead: async (threadId: string, read: boolean) => {
    sidebarActionCalls.push({ method: "setRead", threadId, options: read });
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

export const experimental_useSidebarThreadSplit = (threadId: string) => ({
  splitProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      splitPointerDownCalls.push({
        threadId,
        targetTitle: target?.closest<HTMLElement>("[title]")?.title ?? null,
        currentThreadId:
          event.currentTarget
            .querySelector<HTMLElement>("[data-sidebar-thread-id]")
            ?.getAttribute("data-sidebar-thread-id") ?? null,
      });
    },
  },
});

export const useRpc = () => rpc;

export const useRealtime = () => {};

export const useRealtimeConnectionState = () => "connected" as const;
