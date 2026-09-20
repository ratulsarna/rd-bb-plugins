import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createPipelineCapacity } from "../lib/capacity";
import { createPipelineControls } from "../lib/controls";
import { pauseInstruction } from "../lib/control-prompts";
import { createCardStore, MIGRATIONS } from "../lib/store";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => { while (hosts.length) await hosts.pop()!.harness.lifecycle.dispose(); });

function setup() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const busy = new Set<string>();
  const queue: ReturnType<typeof makeQueueEntry>[] = [];
  const host = createFakePluginHost({ pluginId: "pipeline", sdk: { threads: {
    get: async ({ threadId }) => {
      const thread = threads.get(threadId);
      if (!thread) throw Object.assign(new Error("thread not found"), { status: 404 });
      return thread;
    },
    getPluginMetadata: async () => ({}),
    listRunning: async () => [...busy].map((id) => ({ id, hostId: "host_a" })),
    queue: { list: async () => queue },
    queuedMessages: { delete: async ({ queuedMessageId }) => {
      const index = queue.findIndex((entry) => entry.id === queuedMessageId);
      if (index >= 0) queue.splice(index, 1);
      return { ok: true };
    } },
    send: async () => ({ ok: true, delivery: "sent" }),
    stop: async ({ threadId }) => { busy.delete(threadId); return { ok: true }; },
  } } });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db);
  store.create({ id: "card", projectId: "project", hostId: "host_a", title: "Task", body: "", attachments: [], source: "ui" });
  store.update("card", { leadThreadId: "lead", ownerRole: "lead", column: "implementing" });
  const launch = vi.fn(async () => store.get("card")!);
  const service = { launch, retry: vi.fn(async () => store.get("card")!), onThreadQueueChanged: vi.fn(async () => {}) };
  const controls = createPipelineControls(host.bb, store, service);
  const capacity = createPipelineCapacity(host.bb, store);
  const thread = (id: string, parentThreadId: string | null = null, status: "active" | "idle" | "pending" = "active") => {
    const value = makeThreadResponse({ id, projectId: "project", parentThreadId, status });
    threads.set(id, value);
    if (status === "active") busy.add(id);
    return value;
  };
  thread("lead");
  const card = () => store.get("card")!;
  const acknowledge = () => controls.acknowledge({ threadId: "lead", requestId: card().pauseRequestId! });
  return { ...host, store, threads, busy, queue, controls, capacity, launch, service, thread, card, acknowledge };
}

describe("graceful task controls", () => {
  it("steers once, waits for acknowledgement and all task activity, and preserves queued work", async () => {
    const s = setup();
    s.thread("worker", "lead");
    s.thread("nested", "worker", "idle");
    s.busy.add("nested"); // An idle thread can still own a goal or background work.
    s.queue.push(makeQueueEntry({ id: "ordinary", threadId: "worker" }));
    await Promise.all([s.controls.pause("card"), s.controls.pause("card")]);
    expect(s.card()).toMatchObject({ runState: "pause_requested", column: "implementing", controlError: null });
    expect(s.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(s.harness.inspection.sdk.callsTo("threads.send")[0]![0]).toMatchObject({ threadId: "lead", mode: "steer", input: [{ text: pauseInstruction(s.card()) }] });
    expect(s.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    await s.acknowledge();
    expect(s.card().runState).toBe("pausing");
    s.busy.delete("lead");
    s.busy.delete("worker");
    await s.controls.onActivity(s.threads.get("worker")!);
    expect(s.card().runState).toBe("pausing");
    s.busy.clear();
    await s.controls.onActivity(s.threads.get("nested")!);
    expect(s.card()).toMatchObject({ runState: "paused", column: "implementing" });
    expect(s.queue.map((entry) => entry.id)).toEqual(["ordinary"]);
  });

  it("holds ordinary turns and cold workers while allowing the current pause instruction and worker coordination", async () => {
    const s = setup();
    s.thread("worker", "lead", "idle");
    s.thread("new-worker", "lead", "pending");
    s.thread("ordinary", null, "idle");
    await s.controls.pause("card");
    const decide = (id: string, text = "Do more work", senderThreadId: string | null = null, join = false) => s.capacity.decide(makeMessageDispatchHookContext({
      thread: s.threads.get(id)!, host: { id: "host_a" },
      input: { text, blocks: [{ type: "text", text, mentions: [] }] }, senderThreadId,
      attempt: join ? "join-turn" : "start-turn",
    }));
    expect(await decide("lead", "More work", null, true)).toMatchObject({ action: "wait" });
    expect(await decide("lead", pauseInstruction(s.card()), null, true)).toEqual({ action: "proceed" });
    expect(await decide("worker", "Save a handoff and pause", "lead")).toEqual({ action: "proceed" });
    expect(await decide("new-worker", "New assignment", "lead")).toMatchObject({ action: "wait" });
    expect(await decide("ordinary")).toEqual({ action: "proceed" });
    const completionNotice = makeMessageDispatchHookContext({ thread: s.threads.get("lead")!, host: { id: "host_a" }, initiator: "system", senderThreadId: null });
    expect(await s.capacity.decide(completionNotice)).toEqual({ action: "proceed" });
    await s.acknowledge();
    expect(await s.capacity.decide(completionNotice)).toMatchObject({ action: "wait" });
    expect(await decide("worker", "Late assignment", "lead")).toMatchObject({ action: "wait" });
    expect(await decide("lead", pauseInstruction(s.card()), null, true)).toMatchObject({ action: "wait" });
  });

  it("pauses an unstarted task without running intake and resumes its original queued kickoff", async () => {
    const s = setup();
    s.thread("lead", null, "pending");
    s.busy.clear();
    s.queue.push(makeQueueEntry({ id: "kickoff", threadId: "lead" }));
    expect((await s.controls.pause("card")).runState).toBe("paused");
    expect(s.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    await s.controls.resume("card");
    expect(s.card().runState).toBe("running");
    expect(s.queue.map((entry) => entry.id)).toEqual(["kickoff"]);
    expect(s.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("keeps a queued pause request through reload and rejects stale or non-owner acknowledgements", async () => {
    const s = setup();
    s.harness.inspection.sdk.stub("threads.send", async ({ threadId, input }) => {
      const entry = makeQueueEntry({ id: "pause-message", threadId, content: input, waitingOn: { kind: "interaction" } });
      s.queue.push(entry);
      return { ok: true, delivery: "queued", queuedMessage: entry };
    });
    await s.controls.pause("card");
    const token = s.card().pauseRequestId!;
    const recovered = createPipelineControls(s.bb, s.store, s.service);
    await recovered.startup();
    await recovered.pause("card");
    expect(s.card().runState).toBe("pause_requested");
    expect(s.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    await expect(recovered.acknowledge({ cardId: "card", threadId: "worker", requestId: token })).rejects.toThrow("current intake or lead");
    await expect(recovered.acknowledge({ threadId: "lead", requestId: "old-request" })).rejects.toThrow("no longer current");
    s.busy.clear();
    await recovered.acknowledge({ threadId: "lead", requestId: token });
    s.harness.inspection.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
    await Promise.all([recovered.resume("card"), recovered.resume("card")]);
    expect(s.queue).toHaveLength(0);
    expect(s.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
    await expect(recovered.acknowledge({ threadId: "lead", requestId: token })).rejects.toThrow("no longer current");
  });

  it("does not pretend an offline or partly stopped task has paused and retries without touching unrelated work", async () => {
    const s = setup();
    s.store.update("card", { intakeThreadId: "deleted-intake" });
    s.thread("worker", "lead");
    s.thread("unrelated");
    s.harness.inspection.sdk.stub("threads.stop", async ({ threadId }) => {
      if (threadId === "worker") throw new Error("machine offline");
      s.busy.delete(threadId);
      return { ok: true };
    });
    await s.controls.stop("card");
    expect(s.card()).toMatchObject({ runState: "stopping", controlError: expect.stringContaining("machine offline") });
    await expect(s.controls.resume("card")).rejects.toThrow("finish pausing");
    s.harness.inspection.sdk.stub("threads.stop", async ({ threadId }) => { s.busy.delete(threadId); return { ok: true }; });
    await s.controls.stop("card");
    expect(s.card()).toMatchObject({ runState: "paused", controlError: null });
    expect([...s.busy]).toEqual(["unrelated"]);
    expect(s.harness.inspection.sdk.callsTo("threads.stop").map((call) => call[0])).not.toContainEqual({ threadId: "unrelated" });
  });

  it("requires real quiescence even when stop returns success, including retained deleted occupancy", async () => {
    const s = setup();
    const deleted = s.thread("deleted-worker", "lead");
    s.threads.set(deleted.id, { ...deleted, deletedAt: 1, status: "stopping" });
    s.harness.inspection.sdk.stub("threads.stop", async () => ({ ok: true }));
    await s.controls.stop("card");
    expect(s.card().runState).toBe("stopping");
    s.busy.clear();
    await s.controls.onActivity(deleted);
    expect(s.card().runState).toBe("paused");
  });

  it("stops a descendant whose admitted start finishes after the stop request", async () => {
    const s = setup();
    s.thread("late-worker", "lead", "pending");
    s.busy.add("late-worker");
    await s.controls.stop("card");
    expect(s.card().runState).toBe("stopping");
    expect(s.harness.inspection.sdk.callsTo("threads.stop").map((call) => call[0])).not.toContainEqual({ threadId: "late-worker" });
    await s.controls.onActivity(s.thread("late-worker", "lead", "active"), true);
    expect(s.card().runState).toBe("paused");
    expect(s.harness.inspection.sdk.callsTo("threads.stop").map((call) => call[0])).toContainEqual({ threadId: "late-worker" });
  });

  it("recovers acknowledged pauses after reload and does not call an admitted failed resume paused", async () => {
    const s = setup();
    await s.controls.pause("card");
    await s.acknowledge();
    s.busy.clear();
    const recovered = createPipelineControls(s.bb, s.store, s.service);
    await recovered.startup();
    expect(s.card().runState).toBe("paused");
    s.harness.inspection.sdk.stub("threads.send", async () => { s.busy.add("lead"); throw new Error("reply lost"); });
    await recovered.resume("card");
    expect(s.card()).toMatchObject({ runState: "pausing", controlError: "reply lost" });
  });
});
