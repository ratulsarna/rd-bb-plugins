import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { createPipelineCapacity } from "../lib/capacity";
import { pauseInstruction } from "../lib/control-prompts";
import { createCardStore, MIGRATIONS } from "../lib/store";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function setup() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, { cardId: string }>();
  const running: Array<{ id: string; hostId: string }> = [];
  const queue: Array<ReturnType<typeof makeQueueEntry>> = [];
  const host = createFakePluginHost({
    pluginId: "pipeline",
    sdk: {
      threads: {
        get: async ({ threadId, experimental_includeDeleted }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error(`Missing test thread ${threadId}`);
          if (thread.deletedAt !== null && !experimental_includeDeleted) throw new Error("Thread not found");
          return thread;
        },
        getPluginMetadata: async ({ threadId, experimental_includeDeleted }) => {
          if (threads.get(threadId)?.deletedAt != null && !experimental_includeDeleted) throw new Error("Thread not found");
          return metadata.get(threadId) ?? {};
        },
        listRunning: async () => running,
        queue: { list: async () => queue },
      },
    },
  });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db);
  const capacity = createPipelineCapacity(host.bb, store);

  function thread(id: string, options: {
    cardId?: string;
    parent?: string;
    project?: string;
    machine?: string;
    running?: boolean;
  } = {}) {
    const value = makeThreadResponse({
      id,
      projectId: options.project ?? "project_a",
      originPluginId: options.cardId ? "pipeline" : null,
      parentThreadId: options.parent ?? null,
      status: options.running ? "active" : "idle",
    });
    threads.set(id, value);
    if (options.cardId) metadata.set(id, { cardId: options.cardId });
    if (options.running) running.push({ id, hostId: options.machine ?? "machine_a" });
    return value;
  }

  async function decide(id: string, machine = "machine_a", join = false) {
    const target = threads.get(id)!;
    return capacity.decide(makeMessageDispatchHookContext({
      thread: target,
      project: { id: target.projectId },
      host: { id: machine, name: machine },
      attempt: join ? "join-turn" : "start-turn",
    }));
  }
  return { ...host, capacity, store, threads, running, queue, thread, decide };
}

describe("Pipeline task capacity", () => {
  it("holds a third task, but does not gate ordinary threads or other project/machine pairs", async () => {
    const s = setup();
    s.thread("a", { cardId: "a", running: true });
    s.thread("b", { cardId: "b", running: true });
    s.thread("c", { cardId: "c" });
    s.thread("ordinary");
    s.thread("other_project", { cardId: "d", project: "project_b" });

    expect(await s.decide("c")).toMatchObject({ action: "wait", reason: expect.stringContaining("2 tasks") });
    const readsBefore = s.harness.inspection.sdk.callsTo("threads.listRunning").length;
    expect(await s.decide("ordinary")).toEqual({ action: "proceed" });
    expect(s.harness.inspection.sdk.callsTo("threads.listRunning")).toHaveLength(readsBefore);
    expect(await s.decide("other_project")).toEqual({ action: "proceed" });
    expect(await s.decide("c", "machine_b")).toEqual({ action: "proceed" });
  });

  it("groups intake, lead and nested workers into one slot and permits a running task to continue", async () => {
    const s = setup();
    s.thread("intake", { cardId: "a", running: true });
    s.thread("lead", { cardId: "a", running: true });
    s.thread("worker", { parent: "lead", running: true });
    s.thread("nested", { parent: "worker" });
    s.thread("b", { cardId: "b" });
    expect(await s.decide("b")).toEqual({ action: "proceed" });
    s.running.push({ id: "b", hostId: "machine_a" });
    expect(await s.decide("nested")).toEqual({ action: "proceed" });
    expect(await s.decide("intake", "machine_a", true)).toEqual({ action: "proceed" });
  });

  it("reacquires capacity after intake stops and admits waiting planning only after another task stops", async () => {
    const s = setup();
    s.thread("intake", { cardId: "a" });
    s.thread("lead", { cardId: "a" });
    s.thread("b", { cardId: "b", running: true });
    s.thread("c", { cardId: "c", running: true });
    expect(await s.decide("lead")).toMatchObject({ action: "wait" });
    s.running.splice(0, 1);
    expect(await s.decide("lead")).toEqual({ action: "proceed" });
  });

  it("rechecks pause state after a delayed occupancy read", async () => {
    const s = setup();
    s.store.create({ id: "card", projectId: "project_a", hostId: "machine_a", title: "Card", body: "", attachments: [], source: "ui" });
    s.thread("task", { cardId: "card" });
    let release!: () => void;
    const occupancyStarted = new Promise<void>((resolveStarted) => {
      s.harness.inspection.sdk.stub("threads.listRunning", async () => {
        resolveStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        return [];
      });
    });

    const decision = s.decide("task");
    await occupancyStarted;
    s.store.update("card", { runState: "pause_requested", pauseRequestId: "request" }, {
      kind: "pause_requested", source: "control",
    });
    release();

    expect(await decision).toMatchObject({ action: "wait" });
  });

  it("rechecks pause state after resolving a coordinating sender", async () => {
    const s = setup();
    s.store.create({ id: "card", projectId: "project_a", hostId: "machine_a", title: "Card", body: "", attachments: [], source: "ui" });
    s.store.update("card", {
      leadThreadId: "lead", ownerRole: "lead", runState: "pause_requested", pauseRequestId: "request",
    }, { kind: "pause_requested", source: "control" });
    s.thread("lead", { cardId: "card" });
    s.thread("worker", { cardId: "card" });
    let release!: () => void;
    const senderReadStarted = new Promise<void>((resolveStarted) => {
      s.harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
        if (threadId === "lead") {
          resolveStarted();
          await new Promise<void>((resolve) => { release = resolve; });
        }
        const thread = s.threads.get(threadId);
        if (!thread) throw new Error(`Missing test thread ${threadId}`);
        return thread;
      });
    });
    const decision = s.capacity.decide(makeMessageDispatchHookContext({
      thread: s.threads.get("worker")!,
      host: { id: "machine_a", name: "machine_a" },
      initiator: "agent",
      senderThreadId: "lead",
      attempt: "join-turn",
    }));

    await senderReadStarted;
    s.store.update("card", { runState: "pausing" });
    release();

    expect(await decision).toMatchObject({ action: "wait" });
  });

  it("holds a deleted coordinating sender but surfaces other lookup failures", async () => {
    const s = setup();
    s.store.create({ id: "card", projectId: "project_a", hostId: "machine_a", title: "Card", body: "", attachments: [], source: "ui" });
    s.store.update("card", {
      leadThreadId: "lead", ownerRole: "lead", runState: "pause_requested", pauseRequestId: "request",
    }, { kind: "pause_requested", source: "control" });
    s.thread("worker", { cardId: "card" });
    const context = makeMessageDispatchHookContext({
      thread: s.threads.get("worker")!,
      host: { id: "machine_a", name: "machine_a" },
      initiator: "agent",
      senderThreadId: "deleted-sender",
      attempt: "join-turn",
    });

    s.harness.inspection.sdk.stub("threads.get", async () => {
      throw Object.assign(new Error("thread not found"), { status: 404 });
    });
    expect(await s.capacity.decide(context)).toMatchObject({ action: "wait" });

    s.harness.inspection.sdk.stub("threads.get", async () => { throw new Error("machine offline"); });
    await expect(s.capacity.decide(context)).rejects.toThrow("machine offline");
  });

  it("holds pre-pause queued work without blocking fresh shutdown coordination or control notices", async () => {
    const s = setup();
    s.store.create({ id: "card", projectId: "project_a", hostId: "machine_a", title: "Card", body: "", attachments: [], source: "ui" });
    s.store.update("card", {
      leadThreadId: "lead", ownerRole: "lead", runState: "pause_requested", pauseRequestId: "request",
    }, { kind: "pause_requested", source: "control" });
    s.thread("lead", { cardId: "card" });
    s.thread("worker", { cardId: "card" });
    const card = s.store.get("card")!;
    const cutoff = s.store.history("card").find((entry) => entry.kind === "pause_requested")!.at;
    s.store.recordHistory("card", { kind: "pause_retried", source: "control" });
    const message = (createdAt: number, id: string) => makeQueueEntry({
      id,
      threadId: "worker",
      initiator: "agent",
      senderThreadId: "lead",
      createdAt,
    });
    const coordinate = (queuedMessages: ReturnType<typeof makeQueueEntry>[]) => s.capacity.decide(
      makeMessageDispatchHookContext({
        thread: s.threads.get("worker")!,
        host: { id: "machine_a", name: "machine_a" },
        initiator: "agent",
        senderThreadId: "lead",
        queuedMessages,
      }),
    );

    expect(await coordinate([message(cutoff - 1, "old")])).toMatchObject({ action: "wait" });
    expect(await coordinate([message(cutoff, "fresh")])).toEqual({ action: "proceed" });
    expect(await coordinate([])).toEqual({ action: "proceed" });
    expect(await coordinate([
      message(cutoff - 1, "grouped-old"),
      message(cutoff + 1, "grouped-fresh"),
    ])).toMatchObject({ action: "wait" });

    const pausePrompt = pauseInstruction(card);
    expect(await s.capacity.decide(makeMessageDispatchHookContext({
      thread: s.threads.get("lead")!,
      host: { id: "machine_a", name: "machine_a" },
      input: { text: pausePrompt, blocks: [{ type: "text", text: pausePrompt, mentions: [] }] },
      queuedMessages: [{
        ...message(cutoff - 1, "pause-control"),
        threadId: "lead",
        senderThreadId: null,
        content: [{ type: "text", text: pausePrompt, mentions: [] }],
      }],
      attempt: "join-turn",
    }))).toEqual({ action: "proceed" });
    expect(await s.capacity.decide(makeMessageDispatchHookContext({
      thread: s.threads.get("lead")!,
      host: { id: "machine_a", name: "machine_a" },
      initiator: "system",
      senderThreadId: null,
      attempt: "join-turn",
    }))).toEqual({ action: "proceed" });

    for (const runState of ["pausing", "paused", "stopping"] as const) {
      s.store.update("card", { runState });
      expect(await coordinate([message(cutoff + 1, runState)])).toMatchObject({ action: "wait" });
    }
  });

  it("counts work even after its card was removed and its parent became idle", async () => {
    const s = setup();
    s.store.create({ id: "a", projectId: "project_a", hostId: "machine_a", title: "A", body: "", attachments: [], source: "ui" });
    s.store.update("a", { intakeThreadId: "a" });
    s.thread("a", { cardId: "a" });
    s.thread("worker", { parent: "a", running: true });
    s.thread("b", { cardId: "b", running: true });
    s.thread("c", { cardId: "c" });
    s.store.remove("a");
    expect(await s.decide("c")).toMatchObject({ action: "wait" });
  });

  it("uses dispatch occupancy for pending admissions, stopping threads and idle background work", async () => {
    const s = setup();
    s.thread("a", { cardId: "a", running: true });
    s.thread("b", { cardId: "b", running: true });
    s.threads.set("a", { ...s.threads.get("a")!, status: "stopping" });
    s.threads.set("b", { ...s.threads.get("b")!, status: "idle" });
    s.thread("c", { cardId: "c" });
    expect(await s.decide("c")).toMatchObject({ action: "wait" });
    expect(s.harness.inspection.sdk.callsTo("threads.listRunning").at(-1)?.[0])
      .toEqual({ experimental_includeDispatchOccupancy: true });
  });

  it("keeps counting a deleted thread and its descendants until their execution stops", async () => {
    const s = setup();
    s.thread("a", { cardId: "a", running: true });
    s.thread("worker", { parent: "a", running: true });
    s.threads.set("a", { ...s.threads.get("a")!, deletedAt: 1, status: "stopping" });
    s.threads.set("worker", { ...s.threads.get("worker")!, deletedAt: 1 });
    s.thread("b", { cardId: "b", running: true });
    s.thread("c", { cardId: "c" });

    expect(await s.decide("c")).toMatchObject({ action: "wait" });
    s.running.splice(0, 2);
    expect(await s.decide("c")).toEqual({ action: "proceed" });
  });

  it("recognizes first dispatch from spawn metadata before the card records the new thread", async () => {
    const s = setup();
    s.thread("a", { cardId: "a", running: true });
    s.thread("b", { cardId: "b", running: true });
    s.thread("new", { cardId: "c" });
    s.threads.set("new", { ...s.threads.get("new")!, status: "pending" });
    expect(s.store.getByThread("new")).toBeNull();
    expect(await s.decide("new")).toMatchObject({ action: "wait" });
  });

  it("derives queued cards from durable messages, including children and another plugin holding the wait", async () => {
    const s = setup();
    s.thread("a", { cardId: "a" });
    s.thread("worker", { parent: "a" });
    s.thread("other", { cardId: "other", project: "project_b" });
    s.thread("ordinary");
    for (const id of ["a", "worker", "other", "ordinary"]) {
      s.queue.push(makeQueueEntry({ id: `q_${id}`, threadId: id }));
    }
    expect(await s.capacity.queuedCardIds("project_a")).toEqual(["a"]);
    const recovered = createPipelineCapacity(s.bb, s.store);
    expect(await recovered.queuedCardIds("project_a")).toEqual(["a"]);
    s.queue.length = 0;
    expect(await recovered.queuedCardIds("project_a")).toEqual([]);
  });
});
