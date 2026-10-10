import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { Busy, handover } from "./handover";
import type { Timing } from "./service";
import { IDENTITY, settle, world } from "./world";

const worlds: Array<ReturnType<typeof world>> = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.dispose();
});

/** A memory-on assistant with a short chat: no summaries needed, so it is always ready. */
async function ready(options: Parameters<typeof world>[0] = {}, timing: Partial<Timing> = {}, spawnProcess?: typeof spawn) {
  const w = world(options);
  worlds.push(w);
  const svc = w.service(timing, spawnProcess);
  await svc.on("thr_main");
  w.say("thr_main", "hello");
  w.reply("thr_main", "hi there");
  const rotate = () => handover(svc, { identity: IDENTITY, oldThreadId: "thr_main" });
  const calls = (p: string) => w.harness.inspection.sdk.callsTo(p);
  return { w, svc, rotate, calls };
}

const status = (w: ReturnType<typeof world>, id: string, s: "idle" | "active") => void (w.threads.get(id)!.status = s);
const target = (w: ReturnType<typeof world>) => w.automations[0].automation.execution.targetThreadId;

describe("the safe moment", () => {
  it.each([
    ["the old thread is running", (w: ReturnType<typeof world>) => status(w, "thr_main", "active")],
    ["a child is pending", (w: ReturnType<typeof world>) => w.thread("thr_c", { parentThreadId: "thr_main", status: "pending" })],
    ["an idle child has an active grandchild", (w: ReturnType<typeof world>) => {
      w.thread("thr_c", { parentThreadId: "thr_main" });
      w.thread("thr_g", { parentThreadId: "thr_c", status: "active" });
    }],
    ["an idle child still runs a background command", (w: ReturnType<typeof world>) => {
      const child = w.thread("thr_c", { parentThreadId: "thr_main" });
      child.activity.activeBackgroundCommandCount = 1;
    }],
    ["a child changed 2 seconds ago", (w: ReturnType<typeof world>) => w.thread("thr_c", { parentThreadId: "thr_main", updatedAt: Date.now() - 2000 })],
    ["a message is queued on the old thread", (w: ReturnType<typeof world>) => w.queue("thr_main")],
    ["the old thread runs a background task", (w: ReturnType<typeof world>) => void (w.threads.get("thr_main")!.activity.activeBackgroundAgentCount = 1)],
  ])("refuses with nothing changed when %s", async (_name, arrange) => {
    const { w, svc, rotate, calls } = await ready({}, { quietMs: 5000 });
    arrange(w);
    await expect(rotate()).rejects.toBeInstanceOf(Busy);
    expect(calls("threads.spawn")).toEqual([]);
    expect(calls("threads.archive")).toEqual([]);
    expect(svc.holds.size).toBe(0);
    expect(svc.state(IDENTITY)).toMatchObject({ main: "thr_main", handover: null });
  });

  it("refuses while another handover of the same assistant is unfinished", async () => {
    const { svc, rotate, calls } = await ready();
    svc.update(IDENTITY, { handover: { old: "thr_x", new: "thr_y", step: "spawned", at: 0 } });
    await expect(rotate()).rejects.toThrow(/not finished/);
    expect(calls("threads.spawn")).toEqual([]);
  });
});

it("moves automations only once the new thread runs, and resumes when a slow one becomes active", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 40 });
  expect((await rotate()).warning).toMatch(/thr_new1 has not started/);
  expect(svc.state(IDENTITY)).toMatchObject({ main: "thr_new1", handover: { step: "spawned" } });
  expect(target(w)).toBe("thr_main");
  expect(calls("threads.archive")).toEqual([]);
  expect(svc.holds.size).toBe(0);

  status(w, "thr_new1", "active");
  svc.onActive("thr_new1");
  await settle();
  expect(target(w)).toBe("thr_new1");
  expect(calls("threads.archive")).toEqual([[{ threadId: "thr_main" }]]);
  expect(svc.state(IDENTITY).handover!.step).toBe("done");
});

it("keeps the old thread live and logged while an automation cannot follow, and a restart finishes the move", async () => {
  const { w, svc, rotate, calls } = await ready();
  w.failures.update = new Error("target not runnable");
  expect((await rotate()).warning).toMatch(/heartbeat: target not runnable/);
  expect(svc.state(IDENTITY).handover!.step).toBe("spawned");
  expect(calls("threads.archive")).toEqual([]);
  // The automation still runs against the old thread; what it says there is still memory.
  w.say("thr_main", "heartbeat ran");
  svc.onEvents("thr_main");
  await settle();
  expect(svc.chat(IDENTITY).msgs.at(-1)!.text).toBe("heartbeat ran");

  delete w.failures.update;
  svc.dispose();
  const restarted = w.service();
  await restarted.start();
  await settle();
  expect(target(w)).toBe("thr_new1");
  expect(calls("threads.archive")).toEqual([[{ threadId: "thr_main" }]]);
  expect(restarted.state(IDENTITY).handover!.step).toBe("done");
});

it("moves a plain message that arrived during the hold before archiving, which would drop it", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 1000 });
  const moving = rotate();
  await settle();
  expect(svc.holds.has("thr_main")).toBe(true);
  const plain = w.queue("thr_main", {
    content: [{ type: "text", text: "one more thing", mentions: [] }],
    senderThreadId: "thr_side", model: "m-2", reasoningLevel: "low", permissionMode: "auto", serviceTier: "fast",
  });
  status(w, "thr_new1", "idle");
  expect(await moving).toEqual({ newThreadId: "thr_new1" });
  expect(calls("threads.archive")).toHaveLength(1);
  expect(w.queued.get("thr_new1")).toEqual([
    expect.objectContaining({ content: plain.content, senderThreadId: "thr_side", model: "m-2", reasoningLevel: "low", permissionMode: "auto", serviceTier: "fast" }),
  ]);
  expect(svc.holds.size).toBe(0);
});

it("keeps the old thread while a message it cannot move waits there, and archives once it is gone", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 1000, retryMs: 80 });
  const moving = rotate();
  await settle();
  const system = w.queue("thr_main", { initiator: "system" });
  status(w, "thr_new1", "idle");
  expect((await moving).warning).toMatch(new RegExp(`cannot move: ${system.id}`));
  expect(calls("threads.archive")).toEqual([]);
  expect(svc.state(IDENTITY).handover!.step).toBe("spawned");
  // Released, it went out on the old thread; the retry timer finishes the move.
  w.queued.set("thr_main", []);
  await settle(150);
  expect(calls("threads.archive")).toHaveLength(1);
  expect(svc.state(IDENTITY).handover!.step).toBe("done");
});

it("rotates an old thread whose last turn failed", async () => {
  const { w, rotate, calls } = await ready();
  w.threads.get("thr_main")!.status = "error";
  expect(await rotate()).toEqual({ newThreadId: "thr_new1" });
  expect(calls("threads.archive")).toHaveLength(1);
});

it("does not archive while a child that got a message during the hold runs, and archives on the timer after", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 1000, quietMs: 10, retryMs: 80 });
  const moving = rotate();
  await settle();
  const child = w.thread("thr_child", { parentThreadId: "thr_main", status: "active" });
  status(w, "thr_new1", "idle");
  await moving;
  expect(calls("threads.archive")).toEqual([]);
  expect(svc.state(IDENTITY).handover!.step).toBe("spawned");
  child.status = "idle";
  await settle(150);
  expect(calls("threads.archive")).toHaveLength(1);
});

it("stops waiting at once for a new thread that failed, and memory off gives the assistant its old chat back", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "error" }, { runnableMs: 5000 });
  const started = Date.now();
  expect((await rotate()).warning).toMatch(/thr_new1 failed to start/);
  expect(Date.now() - started).toBeLessThan(1000);
  svc.off(IDENTITY);
  expect(svc.state(IDENTITY)).toMatchObject({ on: false, main: "thr_main", handover: null });
  expect(svc.state(IDENTITY).warnings.at(-1)!.text).toMatch(/Handover to thr_new1 dropped; thr_main is the main chat again/);
  expect(calls("threads.archive")).toEqual([]);
  expect(w.threads.get("thr_new1")!.archivedAt).toBeNull();
});

it("finishes a move a stuck automation held up on the retry timer, once the automation can follow", async () => {
  const { w, svc, rotate } = await ready({}, { retryMs: 80 });
  w.failures.update = new Error("target not runnable");
  await rotate();
  delete w.failures.update;
  await settle(150);
  expect(target(w)).toBe("thr_new1");
  expect(svc.state(IDENTITY).handover!.step).toBe("done");
});

describe("a rotation someone asked for", () => {
  /** `claude -p` answering after `ms`, with `reply`. */
  const claude = (reply: string, ms: number) =>
    (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }) as any;
      child.stdin = Object.assign(new EventEmitter(), {
        end: () => setTimeout(() => (child.stdout.emit("data", reply), child.emit("close", 0, null)), ms),
      });
      return child;
    }) as unknown as typeof spawn;

  it("waits for summaries still running", async () => {
    const { w, rotate } = await ready({}, {}, claude("a line", 60));
    w.say("thr_main", "x".repeat(900));
    expect(await rotate()).toEqual({ newThreadId: "thr_new1" });
  });

  it("says so when summaries keep failing", async () => {
    const { w, rotate, calls } = await ready({}, {}, claude("", 1));
    w.say("thr_main", "x".repeat(900));
    await expect(rotate()).rejects.toThrow(/Memory summaries keep failing \(1 failed\)/);
    expect(calls("threads.spawn")).toEqual([]);
  });
});

it.each(["spawned", "archived"] as const)("finishes a handover a restart left at %s", async (step) => {
  const { w, svc, calls } = await ready();
  w.thread("thr_new1");
  svc.update(IDENTITY, { main: "thr_new1", handover: { old: "thr_main", new: "thr_new1", step, at: 0 } });
  if (step === "archived") w.threads.get("thr_main")!.archivedAt = 1;
  else w.queue("thr_main");
  svc.dispose();
  const restarted = w.service();
  await restarted.start();
  await settle();
  expect(restarted.state(IDENTITY).handover!.step).toBe("done");
  expect(w.queued.get("thr_new1") ?? []).toHaveLength(step === "spawned" ? 1 : 0);
  expect(calls("threads.archive")).toHaveLength(step === "spawned" ? 1 : 0);
});

it("does not start a second run when the new thread turns active while the first still waits for it", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 1000 });
  const moving = rotate();
  await settle();
  w.queue("thr_main");
  status(w, "thr_new1", "active");
  svc.onActive("thr_new1");
  await svc.onIdle("thr_new1");
  await moving;
  await settle();
  expect(calls("threads.archive")).toHaveLength(1);
  expect(w.queued.get("thr_new1")).toHaveLength(1);
});

it("does not archive an old thread whose child started after the first attempt, until the child is done", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 30, retryMs: 60 });
  await rotate();
  const child = w.thread("thr_child", { parentThreadId: "thr_main", status: "active" });
  status(w, "thr_new1", "active");
  svc.onActive("thr_new1");
  await settle(100);
  expect(calls("threads.archive")).toEqual([]);
  expect(target(w)).toBe("thr_main");
  child.status = "idle";
  await settle(100);
  expect(calls("threads.archive")).toEqual([[{ threadId: "thr_main" }]]);
  expect(w.threads.get("thr_child")!.archivedAt).not.toBeNull();
});

it("finishes on the retry timer when only the quiet period refused, with no further lifecycle event", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 30, quietMs: 80, retryMs: 120 });
  await rotate();
  w.thread("thr_child", { parentThreadId: "thr_main", updatedAt: Date.now() });
  status(w, "thr_new1", "idle");
  await svc.onIdle("thr_new1");
  await settle();
  expect(calls("threads.archive")).toEqual([]);
  await settle(200);
  expect(calls("threads.archive")).toHaveLength(1);
  expect(svc.state(IDENTITY).handover!.step).toBe("done");
});

it("finishes a handover that memory off arrived in the middle of", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 1000 });
  const moving = rotate();
  await settle();
  svc.off(IDENTITY);
  status(w, "thr_new1", "idle");
  await moving;
  expect(svc.state(IDENTITY)).toMatchObject({ on: false, main: "thr_new1", handover: { step: "done" } });
  expect(calls("threads.archive")).toHaveLength(1);
});

describe("through the plugin", () => {
  async function loaded(options: Parameters<typeof world>[0] = {}) {
    const w = world(options);
    worlds.push(w);
    plugin(w.bb);
    await settle();
    expect(await w.harness.behavior.runCli(["memory", "on", "thr_main"])).toMatchObject({ exitCode: 0 });
    w.say("thr_main", "hello");
    return w;
  }

  it("holds dispatches to the old thread while it moves, then lets them go", async () => {
    const w = await loaded({ spawnStatus: "starting" });
    const hook = w.harness.inspection.registrations.hooks["message.dispatch"]!;
    const dispatch = (id: string) => hook(makeMessageDispatchHookContext({ thread: { id } }));
    const rotating = w.harness.behavior.runCli(["rotate", "thr_main"]);
    await settle(50);
    expect(await dispatch("thr_main")).toEqual({ action: "wait", reason: "Moving to a new conversation" });
    expect(await dispatch("thr_other")).toEqual({ action: "proceed" });
    w.queue("thr_main", { content: [{ type: "text", text: "sent during the move", mentions: [] }] });
    status(w, "thr_new1", "idle");
    expect(await rotating).toMatchObject({ exitCode: 0, stdout: "Rotated to thr_new1\n" });
    expect(await dispatch("thr_main")).toEqual({ action: "proceed" });
    expect(w.harness.inspection.recheckCount).toBeGreaterThan(0);
    expect(w.queued.get("thr_new1")!.map((r) => r.content)).toEqual([[{ type: "text", text: "sent during the move", mentions: [] }]]);
  });

  it("starts a composed conversation with the view hidden before the user's words, and refuses a scheduled send first", async () => {
    const w = await loaded();
    const seeds = (await w.harness.behavior.callRpc("assistantSeeds", { threadId: "thr_main" })) as { memory: boolean };
    expect(seeds.memory).toBe(true);
    const visible = [{ type: "text", text: "New topic", mentions: [] }];
    const request = (sendAt?: number) => ({
      replaceThreadId: "thr_main", title: "Test", destinationHostId: "srv", homePath: w.home,
      request: { projectId: "fleet", providerId: "codex", model: "m-9", reasoningLevel: "low", permissionMode: "full", executionInputSources: {}, environment: {}, input: visible, ...(sendAt ? { sendAt } : {}) },
    });
    await expect(w.harness.behavior.callRpc("createReplacementThread", request(Date.now() + 60_000))).rejects.toThrow(/Scheduled sends/);
    expect(w.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);

    expect(await w.harness.behavior.callRpc("createReplacementThread", request())).toEqual({ newThreadId: "thr_new1" });
    const [[spawn]] = w.harness.inspection.sdk.callsTo("threads.spawn") as Array<[{ input: Array<{ text: string; visibility?: string }>; model: string }]>;
    expect(spawn.model).toBe("m-9");
    expect(spawn.input).toHaveLength(2);
    expect(spawn.input[0]).toMatchObject({ visibility: "agent-only" });
    expect(spawn.input[0].text).toMatch(/<chat>\n0\+1\|user: hello\n<\/chat>/);
    expect(spawn.input[1]).toEqual(visible[0]);
  });

  it("recalls and dates the calling thread's memory, and says when an assistant has none", async () => {
    const w = await loaded();
    w.emit("thr_main", "item/completed", { item: { type: "agentMessage", id: "m", text: "hi" } });
    await w.harness.behavior.emitThreadEvent("experimental_thread.events", { thread: w.threads.get("thr_main")!, sequence: 2 });
    await settle();
    expect(await w.harness.behavior.runCli(["recall", "0", "2"], { threadId: "thr_main" })).toMatchObject({ exitCode: 0, stdout: "0+1|user: hello\n1+1|unii: hi\n" });
    expect(await w.harness.behavior.runCli(["date", "1", "--assistant", "thr_main"])).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/^2026-09-01T/) });
    expect(await w.harness.behavior.runCli(["recall", "0"])).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/--assistant/) });
    expect(await w.harness.behavior.runCli(["recall", "5", "1"], { threadId: "thr_main" })).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/no line 5\+1/) });
  });
});
