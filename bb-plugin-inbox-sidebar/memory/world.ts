// Test helper: one assistant home on one machine, and the slice of bb the memory code talks to, as plain
// maps a test can change between steps. Temp dirs only.
import type { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakePluginHost, type FakeSdkOverrides, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { EventRow } from "./history";
import { MemoryService, TIMING, type Timing } from "./service";

export type FakeThread = ReturnType<typeof makeThreadResponse> & {
  activity: { activeWorkflowCount: number; activeBackgroundAgentCount: number; activeBackgroundCommandCount: number; activePlanModeCount: number; activeGoalCount: number };
  queuedWork: "none" | "waiting" | "failed";
};
export type QueueEntry = ReturnType<typeof makeQueueEntry>;

export const FAST: Timing = { readinessMs: 2000, readyCapMs: 2000, runnableMs: 300, pollMs: 10, quietMs: 50, retryMs: 100 };
export const IDENTITY = "fleet:zz-test";
export const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

export function world({ spawnStatus = "idle" }: { spawnStatus?: FakeThread["status"] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-world-"));
  const assistantsRoot = path.join(base, "assistants");
  const vault = path.join(base, "vault");
  const home = path.join(assistantsRoot, "zz-test");
  fs.mkdirSync(path.join(home, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "SYSTEM.md"), "");
  fs.mkdirSync(vault);

  const threads = new Map<string, FakeThread>();
  const events = new Map<string, EventRow[]>();
  const queued = new Map<string, QueueEntry[]>();
  const usage = new Map<string, { usedTokens: number; modelContextWindow: number } | null>();
  const automations = [{ automation: { id: "beat", projectId: "fleet", name: "heartbeat", execution: { mode: "agent", targetThreadId: "thr_main" } } }];
  const failures: { update?: Error; events?: Error } = {};
  /** Runs on each events read, before it answers: a test can make something happen mid-read. */
  const taps: { events?: (threadId: string) => void | Promise<void>; get?: (threadId: string) => void | Promise<void>; spawned?: (threadId: string) => void } = {};
  let seq = 0;
  let spawned = 0;
  let rowIds = 0;

  const thread = (id: string, over: Partial<FakeThread> = {}): FakeThread => {
    const t: FakeThread = {
      ...makeThreadResponse({ id, projectId: "fleet", providerId: "codex", environmentId: "env", title: "Test" }),
      activity: { activeWorkflowCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeGoalCount: 0 },
      queuedWork: "none",
      ...over,
    };
    threads.set(id, t);
    return t;
  };
  thread("thr_main");

  /** Append an event to a thread's log, as a provider would. */
  const emit = (threadId: string, type: string, data: Record<string, unknown>) => {
    const row = { seq: ++seq, createdAt: Date.now(), type, data };
    events.set(threadId, [...(events.get(threadId) ?? []), row]);
    return row;
  };
  const say = (threadId: string, text: string) => emit(threadId, "client/turn/requested", { initiator: "user", senderThreadId: null, input: [{ type: "text", text }] });
  const reply = (threadId: string, text: string) => emit(threadId, "item/completed", { item: { type: "agentMessage", id: `m${seq}`, text } });
  const turnEnd = (threadId: string, status: "completed" | "failed" | "interrupted" = "completed") => emit(threadId, "turn/completed", { status });
  const queue = (threadId: string, over: Partial<QueueEntry> = {}) => {
    const row = makeQueueEntry({ id: `q${++rowIds}`, threadId, ...over });
    queued.set(threadId, [...(queued.get(threadId) ?? []), row]);
    return row;
  };

  // Like bb: an archive walks children, lifecycle dependents and hidden source threads, through archived
  // ones and never through deleted ones, and archives each live one; queued rows vanish with it.
  const archive = (id: string, at: number, seen = new Set<string>()) => {
    const t = threads.get(id)!;
    if (seen.has(id) || t.deletedAt !== null) return;
    seen.add(id);
    if (t.archivedAt === null) {
      t.archivedAt = at;
      queued.delete(id);
    }
    for (const o of threads.values()) {
      if (o.parentThreadId === id || o.lifecycleOwnerThreadId === id || (o.sourceThreadId === id && o.visibility === "hidden")) archive(o.id, at, seen);
    }
  };
  /** Each environment's home: `env` is the assistant's own. */
  const environments = new Map([["env", { id: "env", projectId: "fleet", hostId: "srv", path: home as string | null }]]);

  const sdk: FakeSdkOverrides = {
      threads: {
        get: async ({ threadId }) => {
          await taps.get?.(threadId);
          const t = threads.get(threadId);
          if (!t || t.deletedAt !== null) throw Object.assign(new Error(`HTTP 404: thread ${threadId} not found`), { status: 404 });
          return structuredClone(t);
        },
        // Like bb: without `archived`, both archived and live threads; never deleted ones.
        list: async ({ projectId, parentThreadId, hasParent, archived, includeHidden } = {}) =>
          [...threads.values()]
            .filter((t) => t.deletedAt === null && (archived === undefined || archived === (t.archivedAt !== null)) && (includeHidden || t.visibility === "visible"))
            .filter((t) => (projectId === undefined || t.projectId === projectId) && (parentThreadId !== undefined ? t.parentThreadId === parentThreadId : hasParent !== false || t.parentThreadId === null))
            .map((t) => structuredClone(t)),
        events: {
          list: async ({ threadId, types, afterSeq, order, limit }) => {
            if (failures.events) throw failures.events;
            await taps.events?.(threadId);
            const rows = (events.get(threadId) ?? []).filter((r) => (!types || (types as readonly string[]).includes(r.type)) && r.seq > Number(afterSeq ?? 0));
            if (order === "desc") rows.reverse();
            return structuredClone(rows.slice(0, Number(limit ?? 100)));
          },
        },
        context: async ({ threadId }) => ({ usage: usage.get(threadId) ?? null }),
        defaultExecutionOptions: async () => ({ model: "m-1", reasoningLevel: "high", permissionMode: "full", serviceTier: "default" }),
        spawn: async () => {
          const t = thread(`thr_new${++spawned}`, { status: spawnStatus });
          taps.spawned?.(t.id);
          return structuredClone(t);
        },
        archive: async ({ threadId }) => {
          archive(threadId, Date.now());
          return {};
        },
        queuedMessages: {
          list: async ({ threadId }) => structuredClone(queued.get(threadId) ?? []),
          create: async ({ threadId, input, ...rest }) => queue(threadId, { content: input, waitingOn: null, ...rest } as Partial<QueueEntry>),
          delete: async ({ threadId, queuedMessageId }) => {
            queued.set(threadId, (queued.get(threadId) ?? []).filter((r) => r.id !== queuedMessageId));
            return { ok: true };
          },
        },
      },
      environments: {
        get: async ({ environmentId }) => {
          const env = environments.get(environmentId);
          if (!env) throw new Error(`environment ${environmentId} not found`);
          return env;
        },
      },
      projects: { get: async () => ({ id: "fleet", name: "assistants", sources: [{ hostId: "srv", path: assistantsRoot }] }) },
      providers: { list: async () => [{ id: "codex", available: true }] },
      hosts: {
        directory: async ({ path: dir }) => {
          const resolved = fs.realpathSync(dir!);
          return { directory: resolved, parent: path.dirname(resolved), entries: [] };
        },
      },
      files: { read: async ({ path: file }) => ({ path: file, content: fs.readFileSync(file, "utf8"), contentEncoding: "utf8" }) },
      plugins: {
        callRpc: async ({ pluginId, method, input, outputSchema }) => {
          if (pluginId === "private-sync") {
            const node = (p: string) => ({ hostId: "srv", path: p, phase: "ready", ready: true, error: null });
            if (method === "status") {
              return outputSchema.parse({ enabled: false, paused: false, configError: null, folders: [{ id: "assistants", nodes: [node(assistantsRoot)] }, { id: "vault", nodes: [node(vault)] }] });
            }
            if (method === "machineDirectory") return outputSchema.parse([{ hostId: "srv", name: "Server", connected: true }]);
          }
          if (pluginId === "automations") {
            if (method === "automations_overview") return outputSchema.parse({ automations });
            if (failures.update) throw failures.update;
            const { automationId, agent } = input as { automationId: string; agent: { target: { threadId: string } } };
            automations.find((a) => a.automation.id === automationId)!.automation.execution.targetThreadId = agent.target.threadId;
            return outputSchema.parse({});
          }
          throw new Error(`unexpected rpc ${pluginId}.${method}`);
        },
      },
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "inbox-sidebar", sdk });

  const services: MemoryService[] = [];
  /** A service over this world's memory dir, as one plugin load. */
  const service = (timing: Partial<Timing> = {}, spawnProcess?: typeof spawn) => {
    const svc = new MemoryService(bb, path.join(base, "memory"), { ...TIMING, ...FAST, ...timing }, spawnProcess);
    services.push(svc);
    return svc;
  };
  const dispose = async () => {
    await Promise.all(services.splice(0).map((svc) => svc.dispose()));
    return harness.lifecycle.dispose();
  };

  return { bb, harness, base, home, assistantsRoot, environments, threads, events, queued, usage, automations, failures, taps, thread, emit, say, reply, turnEnd, queue, service, dispose };
}
