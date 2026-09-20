import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
  makeHostResponse,
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
  const metadata = new Map<string, { cardId: string; hostId: string }>();
  const running: Array<{ id: string; hostId: string }> = [];
  const queue: Array<ReturnType<typeof makeQueueEntry>> = [];
  const machines = [makeHostResponse({ id: "machine_a", name: "Machine A", status: "connected" }), makeHostResponse({ id: "machine_b", name: "Machine B", status: "connected" })];
  const questions = new Set<string>();
  const host = createFakePluginHost({
    pluginId: "pipeline",
    sdk: {
      hosts: { list: async () => machines },
      environments: { get: async ({ environmentId }) => ({ hostId: environmentId.replace("env_", "") }) as never },
      threads: {
        interactions: { list: async ({ threadId }) => questions.has(threadId) ? [{ status: "pending", turnId: "turn" }] as never : [] },
        queuedMessages: { list: async ({ threadId }) => queue.filter((entry) => entry.threadId === threadId) },
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
      environmentId: `env_${options.machine ?? "machine_a"}`,
    });
    threads.set(id, value);
    if (options.cardId) metadata.set(id, { cardId: options.cardId, hostId: options.machine ?? "machine_a" });
    if (options.running) running.push({ id, hostId: options.machine ?? "machine_a" });
    return value;
  }

  async function decide(id: string, machine = "machine_a", join = false) {
    const target = threads.get(id)!;
    return capacity.decide(makeMessageDispatchHookContext({
      thread: target,
      project: { id: target.projectId },
      host: machines.find((host) => host.id === machine)!,
      attempt: join ? "join-turn" : "start-turn",
    }));
  }
  return { ...host, capacity, store, threads, running, queue, machines, questions, thread, decide };
}

function queuedTask(s: ReturnType<typeof setup>, id: string, machine = "machine_a") {
  s.store.create({ id, projectId: "project_a", hostId: machine, title: id, body: "", attachments: [], source: "ui" });
  const thread = s.thread(id, { cardId: id, machine });
  s.store.update(id, { intakeThreadId: id });
  const entry = makeQueueEntry({ id: `queue_${id}`, threadId: id,
    waitingOn: { kind: "plugin", pluginId: "pipeline", reason: "Pipeline: 2 tasks running" },
  });
  s.queue.push(entry);
  return { thread, entry };
}

describe("Pipeline task capacity", () => {
  it("prioritizes a saved nominee in its pool, without clearing on a tentative hook proceed", async () => {
    const s = setup();
    s.thread("working", { cardId: "working", running: true });
    queuedTask(s, "older");
    const urgent = queuedTask(s, "urgent");
    queuedTask(s, "other-machine", "machine_b");
    await s.capacity.setRunNext("urgent", true);
    expect((await s.capacity.snapshot("project_a")).find((machine) => machine.hostId === "machine_a")).toMatchObject({ nextCardId: "urgent", occupied: [{ cardId: "working" }] });

    const recovered = createPipelineCapacity(s.bb, s.store);
    await recovered.startup();
    expect(await s.decide("older")).toMatchObject({ action: "wait", reason: expect.stringContaining("Run next"), sendAt: expect.any(Number) });
    expect(await s.decide("urgent")).toEqual({ action: "proceed" });
    expect(s.store.getRunNext("project_a", "machine_a")).toBe("urgent");
    expect(await s.decide("working")).toEqual({ action: "proceed" });
    expect(await s.decide("other-machine", "machine_b")).toEqual({ action: "proceed" });

    s.running.push({ id: "urgent", hostId: "machine_a" });
    await recovered.onStarted({ ...urgent.thread, status: "active" });
    expect(s.store.getRunNext("project_a", "machine_a")).toBeNull();
    expect(await s.decide("older")).toMatchObject({ action: "wait", reason: "Pipeline: 2 tasks running" });
    s.running.splice(0, 1);
    expect(await s.decide("older")).toEqual({ action: "proceed" });
  });

  it("lets eligible work pass a nominee with a question, schedule, external wait, or dispatch failure", async () => {
    const s = setup();
    queuedTask(s, "older");
    const { entry } = queuedTask(s, "urgent");
    await s.capacity.setRunNext("urgent", true);
    s.questions.add("urgent");
    expect(await s.decide("older")).toEqual({ action: "proceed" });
    expect((await s.capacity.snapshot("project_a"))[0]?.waiting.find((row) => row.cardId === "urgent")?.reasons).toContain("Waiting for your answer");
    s.questions.clear();
    entry.sendAt = Date.now() + 60_000;
    expect(await s.decide("older")).toEqual({ action: "proceed" });
    entry.sendAt = null;
    entry.failureReason = "Provider unavailable";
    expect(await s.decide("older")).toEqual({ action: "proceed" });
    entry.failureReason = null;
    entry.waitingOn = { kind: "plugin", pluginId: "quiet-hours", reason: "Until morning" };
    expect(await s.decide("older")).toEqual({ action: "proceed" });
    entry.waitingOn = { kind: "plugin", pluginId: "pipeline", reason: "Pipeline: 2 tasks running (also waiting on quiet-hours: Until morning)" };
    expect(await s.decide("older")).toEqual({ action: "proceed" });
    entry.waitingOn = { kind: "plugin", pluginId: "pipeline", reason: "Pipeline: 2 tasks running" };
    s.machines[0]!.status = "disconnected";
    expect(await s.decide("older")).toEqual({ action: "proceed" });
    s.machines[0]!.status = "connected";
    expect(await s.decide("older")).toMatchObject({ action: "wait", reason: expect.stringContaining("Run next") });
  });

  it("does not prioritize one ready message from an otherwise blocked group", async () => {
    const s = setup();
    queuedTask(s, "older");
    const { entry } = queuedTask(s, "urgent");
    entry.groupWithNext = true;
    s.queue.push(makeQueueEntry({ ...entry, id: "scheduled-tail", groupWithNext: false, sendAt: Date.now() + 60_000 }));
    await s.capacity.setRunNext("urgent", true);
    expect(await s.decide("older")).toEqual({ action: "proceed" });
    s.queue.at(-1)!.sendAt = null;
    expect(await s.decide("older")).toMatchObject({ action: "wait" });
  });

  it("uses reordered thread groups rather than global queue creation order", async () => {
    const s = setup();
    queuedTask(s, "older");
    const { entry } = queuedTask(s, "urgent");
    const middle = makeQueueEntry({ ...entry, id: "middle", groupWithNext: true, failureReason: "Cannot dispatch" });
    const first = makeQueueEntry({ ...entry, id: "first", groupWithNext: true });
    s.queue.push(middle, first);
    s.harness.inspection.sdk.stub("threads.queuedMessages.list", async ({ threadId }) =>
      threadId === "urgent" ? [first, middle, entry] : s.queue.filter((row) => row.threadId === threadId));
    await s.capacity.setRunNext("urgent", true);
    expect(await s.decide("older")).toEqual({ action: "proceed" });
    middle.failureReason = null;
    expect(await s.decide("older")).toMatchObject({ action: "wait" });
  });

  it("honors recoverable error threads and plugin questions, but yields for a suspended host", async () => {
    const s = setup();
    queuedTask(s, "older");
    const { thread, entry } = queuedTask(s, "urgent");
    s.threads.set(thread.id, { ...thread, status: "error" });
    s.harness.inspection.sdk.stub("threads.interactions.list", async () => [{ turnId: null, status: "pending" }] as never);
    entry.waitingOn = { kind: "plugin", pluginId: "pipeline", reason: "Pipeline: Run next has priority" };
    entry.sendAt = Date.now() + 5_000;
    await s.capacity.setRunNext("urgent", true);
    expect(await s.decide("older")).toMatchObject({ action: "wait" });
    s.machines[0]!.lifecycle.phase = "suspended";
    expect(await s.decide("older")).toEqual({ action: "proceed" });
    expect((await s.capacity.snapshot("project_a"))[0]?.waiting[0]?.reasons).toContain("Machine suspended or resuming");
  });

  it("bounds a priority wait across rechecks while preserving the two-task limit", async () => {
    const s = setup();
    const older = queuedTask(s, "older");
    queuedTask(s, "urgent");
    await s.capacity.setRunNext("urgent", true);
    const waiting = await s.decide("older");
    if (waiting.action !== "wait") throw new Error("Expected a priority wait");
    older.entry.waitingOn = { kind: "plugin", pluginId: "pipeline", reason: waiting.reason };
    older.entry.sendAt = waiting.sendAt!;
    const recheck = () => s.capacity.decide(makeMessageDispatchHookContext({
      thread: older.thread, host: s.machines[0]!, queuedMessages: [older.entry],
    }));
    expect(await recheck()).toEqual(waiting);
    s.queue.splice(s.queue.findIndex((row) => row.threadId === "urgent"), 1);
    expect(await recheck()).toEqual(waiting);
    older.entry.sendAt = Date.now() - 1;
    expect(await recheck()).toEqual({ action: "proceed" });
    s.thread("busy-a", { cardId: "busy-a", running: true });
    s.thread("busy-b", { cardId: "busy-b", running: true });
    expect(await recheck()).toMatchObject({ action: "wait", reason: "Pipeline: 2 tasks running" });
  });

  it("shows actual occupied tasks even after removal and all durable wait reasons without duplicating a card", async () => {
    const s = setup();
    const removed = queuedTask(s, "removed");
    s.queue.splice(0);
    s.store.remove("removed");
    s.thread("child", { parent: removed.thread.id, running: true });
    s.thread("sibling", { parent: removed.thread.id, running: true });
    const pending = queuedTask(s, "waiting");
    pending.entry.waitingOn = { kind: "plugin", pluginId: "rate-limit", reason: "Try later" };
    s.queue.push(makeQueueEntry({ threadId: "waiting", waitingOn: { kind: "host-offline", hostName: "Machine A" } }));
    s.machines[0]!.status = "disconnected";
    s.questions.add("waiting");
    const queue = await s.capacity.snapshot("project_a");
    expect(queue).toHaveLength(1);
    expect(queue[0]?.occupied).toEqual([{ cardId: "removed", title: "Removed task", threadId: "child" }]);
    expect(queue[0]?.waiting).toEqual([expect.objectContaining({ cardId: "waiting", canRunNext: true, reasons: ["Machine offline", "Waiting for your answer", "rate-limit: Try later"] })]);
  });

  it("clears cancelled and missed-start nominations and rejects tasks that are already occupying a slot", async () => {
    const s = setup();
    const { thread } = queuedTask(s, "urgent");
    await s.capacity.setRunNext("urgent", true);
    s.queue.splice(0);
    await s.capacity.onQueueChanged(thread);
    expect(s.store.getRunNext("project_a", "machine_a")).toBeNull();
    await expect(s.capacity.setRunNext("urgent", true)).rejects.toThrow("requires a queued task");

    s.queue.push(makeQueueEntry({ threadId: "urgent" }));
    await s.capacity.setRunNext("urgent", true);
    s.running.push({ id: "urgent", hostId: "machine_a" });
    await createPipelineCapacity(s.bb, s.store).startup();
    expect(s.store.getRunNext("project_a", "machine_a")).toBeNull();
    await expect(s.capacity.setRunNext("urgent", true)).rejects.toThrow("requires a queued task");
  });

  it("does not save a stale nomination when its queued start is cancelled during validation", async () => {
    const s = setup();
    const { thread, entry } = queuedTask(s, "urgent");
    let release!: () => void;
    const reading = new Promise<void>((started) => {
      s.harness.inspection.sdk.stub("threads.interactions.list", async () => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return [];
      });
    });
    const selecting = expect(s.capacity.setRunNext("urgent", true)).rejects.toThrow("queue changed");
    await reading;
    s.queue.splice(0);
    await s.capacity.onQueueChanged(thread);
    release();
    await selecting;
    expect(s.store.getRunNext("project_a", "machine_a")).toBeNull();
    s.queue.push(entry);
    s.harness.inspection.sdk.stub("threads.interactions.list", async () => []);
    expect((await s.capacity.snapshot("project_a"))[0]?.nextCardId).toBeNull();
  });

  it("preserves a newer choice when an earlier selection finishes validation late", async () => {
    const s = setup();
    queuedTask(s, "first");
    queuedTask(s, "second");
    let release!: () => void;
    let reads = 0;
    const reading = new Promise<void>((started) => {
      s.harness.inspection.sdk.stub("hosts.list", async () => {
        if (reads++ === 0) {
          started();
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return s.machines;
      });
    });
    const first = expect(s.capacity.setRunNext("first", true)).rejects.toThrow("queue changed");
    await reading;
    await s.capacity.setRunNext("second", true);
    release();
    await first;
    expect(s.store.getRunNext("project_a", "machine_a")).toBe("second");
  });

  it("retains machine attribution for removed queued starts without an environment", async () => {
    const s = setup();
    const { thread } = queuedTask(s, "removed", "machine_b");
    s.threads.set(thread.id, { ...thread, status: "pending", environmentId: null });
    s.store.remove("removed");

    const recovered = createPipelineCapacity(s.bb, s.store);
    expect(await recovered.snapshot("project_a")).toEqual([expect.objectContaining({
      hostId: "machine_b", occupied: [], nextCardId: null,
      waiting: [{ cardId: "removed", threadId: "removed", title: "Removed task",
        reasons: ["Waiting for capacity"], canRunNext: false }],
    })]);
  });

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
    expect((await s.capacity.snapshot("project_a"))[0]?.waiting.map((card) => card.cardId)).toEqual(["a"]);
    const recovered = createPipelineCapacity(s.bb, s.store);
    expect((await recovered.snapshot("project_a"))[0]?.waiting.map((card) => card.cardId)).toEqual(["a"]);
    s.queue.length = 0;
    expect(await recovered.snapshot("project_a")).toEqual([]);
  });
});
