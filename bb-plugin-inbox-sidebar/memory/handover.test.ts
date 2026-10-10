import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";
import { Busy, handover } from "./handover";
import { localIso, spokenDate } from "./history";
import type { Timing } from "./service";
import { FAST, IDENTITY, settle, world } from "./world";

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

/** A child of the old thread whose environment is another assistant's home. */
const othersChild = (w: ReturnType<typeof world>, over: Parameters<ReturnType<typeof world>["thread"]>[1] = {}) => {
  w.environments.set("env_b", { id: "env_b", projectId: "fleet", hostId: "srv", path: path.join(w.assistantsRoot, "zz-other") });
  return w.thread("thr_c", { parentThreadId: "thr_main", environmentId: "env_b", ...over });
};

const status = (w: ReturnType<typeof world>, id: string, s: "idle" | "active") => void (w.threads.get(id)!.status = s);
const target = (w: ReturnType<typeof world>) => w.automations[0].automation.execution.targetThreadId;

describe("the safe moment", () => {
  it.each([
    ["the old thread is running", (w: ReturnType<typeof world>) => status(w, "thr_main", "active")],
    ["the old thread runs a background task", (w: ReturnType<typeof world>) => void (w.threads.get("thr_main")!.activity.activeBackgroundAgentCount = 1)],
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
    // Archiving the old thread takes these along too, as it does children.
    ["a thread whose lifecycle it owns runs", (w: ReturnType<typeof world>) => w.thread("thr_d", { lifecycleOwnerThreadId: "thr_main", status: "active" })],
    ["a thread in another project whose lifecycle it owns runs", (w: ReturnType<typeof world>) => w.thread("thr_x", { projectId: "elsewhere", lifecycleOwnerThreadId: "thr_main", status: "active" })],
    ["a live grandchild sits under an archived child", (w: ReturnType<typeof world>) => {
      w.thread("thr_c", { parentThreadId: "thr_main", archivedAt: 1 });
      w.thread("thr_g", { parentThreadId: "thr_c", status: "active" });
    }],
    ["an archived child still runs, which the archive would stop", (w: ReturnType<typeof world>) => w.thread("thr_c", { parentThreadId: "thr_main", archivedAt: 1, status: "active" })],
    // Archived a moment ago: its report to its parent may still be on its way.
    ["an archived child changed 1 second ago", (w: ReturnType<typeof world>) => w.thread("thr_c", { parentThreadId: "thr_main", archivedAt: 1, updatedAt: Date.now() - 1000 })],
    ["a hidden thread made from it runs", (w: ReturnType<typeof world>) => w.thread("thr_h", { sourceThreadId: "thr_main", visibility: "hidden", status: "active" })],
  ])("refuses with nothing changed when %s", async (_name, arrange) => {
    const { w, svc, rotate, calls } = await ready({}, { quietMs: 5000 });
    arrange(w);
    await expect(rotate()).rejects.toBeInstanceOf(Busy);
    expect(calls("threads.spawn")).toEqual([]);
    expect(calls("threads.archive")).toEqual([]);
    expect(svc.holds.size).toBe(0);
    expect(svc.state(IDENTITY)).toMatchObject({ main: "thr_main", previous: [] });
  });

  it("refuses a second handover of the same assistant while one runs", async () => {
    const { w, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 1000 });
    const first = rotate();
    await expect(rotate()).rejects.toThrow(/already running/);
    await vi.waitFor(() => expect(w.threads.has("thr_new1")).toBe(true));
    status(w, "thr_new1", "idle");
    await first;
    expect(calls("threads.spawn")).toHaveLength(1);
  });
});

it("refuses another root in the same home without logging it", async () => {
  const { w, svc, calls } = await ready();
  w.thread("thr_other");
  w.say("thr_other", "not for memory");
  const before = svc.chat(IDENTITY).msgs.map((m) => m.text);
  await expect(handover(svc, { identity: IDENTITY, oldThreadId: "thr_other" })).rejects.toThrow(/not the main chat/);
  expect(svc.chat(IDENTITY).msgs.map((m) => m.text)).toEqual(before);
  expect(calls("threads.spawn")).toEqual([]);
});

it("moves the chat: main, automations and held messages go to the new thread, then the old one is archived", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 1000 });
  const moving = rotate();
  await vi.waitFor(() => expect(w.threads.has("thr_new1")).toBe(true));
  expect(svc.holds.has("thr_main")).toBe(true);
  // Arrived during the hold: a plain message moves; its execution settings are the new thread's now.
  w.queue("thr_main", { content: [{ type: "text", text: "one more thing", mentions: [] }], senderThreadId: "thr_side", model: "m-2" });
  // The last words on the old thread, from a path the hold cannot stop, still reach the log.
  w.reply("thr_main", "a late report");
  status(w, "thr_new1", "idle");
  expect(await moving).toEqual({ newThreadId: "thr_new1" });
  expect(svc.state(IDENTITY)).toMatchObject({ main: "thr_new1", previous: [] });
  expect(target(w)).toBe("thr_new1");
  expect(calls("threads.archive")).toEqual([[{ threadId: "thr_main" }]]);
  expect(calls("threads.queuedMessages.create")).toEqual([[{ threadId: "thr_new1", input: [{ type: "text", text: "one more thing", mentions: [] }], senderThreadId: "thr_side" }]]);
  expect(svc.chat(IDENTITY).msgs.at(-1)!.text).toBe("a late report");
  expect(svc.holds.size).toBe(0);
});

it("moves a message queued while the old thread's last events are read", async () => {
  const { w, rotate } = await ready();
  const late = [{ type: "text" as const, text: "just in time", mentions: [] }];
  w.taps.events = (threadId) => {
    if (threadId !== "thr_main" || !w.threads.has("thr_new1")) return;
    delete w.taps.events;
    w.queue("thr_main", { content: late });
  };
  expect(await rotate()).toEqual({ newThreadId: "thr_new1" });
  expect(w.queued.get("thr_new1")!.map((r) => r.content)).toEqual([late]);
  expect(w.threads.get("thr_main")!.archivedAt).not.toBeNull();
});

describe("an automatic rotation", () => {
  async function due() {
    const r = await ready({}, { retryMs: 30 });
    r.w.turnEnd("thr_main");
    r.w.usage.set("thr_main", { usedTokens: 90, modelContextWindow: 100 });
    return r;
  }

  it.each<[string, (w: ReturnType<typeof world>) => void, string]>([
    ["the main chat has an active goal", (w) => void (w.threads.get("thr_main")!.activity.activeGoalCount = 1), "The main chat has an active goal"],
    ["a child has an active goal", (w) => void (w.thread("thr_c", { parentThreadId: "thr_main" }).activity.activeGoalCount = 1), "Child thr_c has an active goal"],
    ["a child has failed queued messages", (w) => w.thread("thr_c", { parentThreadId: "thr_main", queuedWork: "failed" }), "Child thr_c has failed queued messages"],
    // Nobody composed this move, so it must not archive what is not this assistant's.
    ["a child is in another project", (w) => w.thread("thr_c", { parentThreadId: "thr_main", projectId: "elsewhere" }), "Child thr_c is in another project; archiving thr_main would archive it"],
    ["a child lives in another assistant's home", (w) => othersChild(w), "Child thr_c belongs to another assistant; archiving thr_main would archive it"],
  ])("waits with one warning and no retry loop when %s", async (_name, arrange, why) => {
    const { w, svc, calls } = await due();
    arrange(w);
    await svc.onIdle("thr_main");
    const reads = calls("threads.context").length;
    await settle(150);
    expect(calls("threads.context")).toHaveLength(reads);
    expect(svc.state(IDENTITY).warnings.map((x) => x.text)).toEqual([`rotation waits: ${why}`]);
  });

  it("tries again when it cannot tell whose a child is", async () => {
    const { w, svc, calls } = await due();
    othersChild(w);
    w.environments.delete("env_b");
    w.harness.sdk.stub("environments.get", async () => { throw new Error("server busy"); });
    await svc.onIdle("thr_main");
    const reads = calls("threads.context").length;
    await vi.waitFor(() => expect(calls("threads.context").length).toBeGreaterThan(reads));
    expect(svc.state(IDENTITY).warnings).toEqual([]);
    expect(calls("threads.spawn")).toEqual([]);
  });

  it("passes through an archived thread of another assistant to reach live ones of its own", async () => {
    const { w, svc } = await due();
    othersChild(w, { archivedAt: 1 });
    w.thread("thr_g", { parentThreadId: "thr_c" });
    await svc.onIdle("thr_main");
    expect(svc.state(IDENTITY).main).toBe("thr_new1");
    expect(w.threads.get("thr_g")!.archivedAt).not.toBeNull();
  });

  it("passes an archived child stuck stopping, which the archive leaves be", async () => {
    const { w, svc } = await due();
    w.thread("thr_c", { parentThreadId: "thr_main", archivedAt: 1, status: "stopping" });
    await svc.onIdle("thr_main");
    expect(svc.state(IDENTITY).main).toBe("thr_new1");
  });

  it("counts a child on a host with no assistant source as in no home", async () => {
    const { w, svc } = await due();
    w.environments.set("env_x", { id: "env_x", projectId: "fleet", hostId: "laptop", path: "/home/x/repo" });
    w.thread("thr_c", { parentThreadId: "thr_main", environmentId: "env_x" });
    await svc.onIdle("thr_main");
    expect(svc.state(IDENTITY).main).toBe("thr_new1");
  });

  it("runs in plan mode", async () => {
    const { w, svc } = await due();
    w.threads.get("thr_main")!.activity.activePlanModeCount = 1;
    await svc.onIdle("thr_main");
    expect(svc.state(IDENTITY).main).toBe("thr_new1");
  });
});

it("stops at a plugin reload before the spawn, and the reload waits for it", async () => {
  const { w, svc, rotate, calls } = await ready();
  let answer!: (value: unknown) => void;
  w.harness.sdk.stub("threads.defaultExecutionOptions", () => new Promise((resolve) => (answer = resolve)));
  const moving = rotate();
  await vi.waitFor(() => expect(answer).toBeDefined());
  let stopped = false;
  const disposing = svc.dispose().then(() => (stopped = true));
  await settle();
  expect(stopped).toBe(false);
  answer({ model: "m-1", reasoningLevel: "high", permissionMode: "full", serviceTier: "default" });
  await expect(moving).rejects.toThrow(/memory service stopped/);
  await disposing;
  expect(calls("threads.spawn")).toEqual([]);
  expect(svc.holds.size).toBe(0);
});

it("rotates an old thread whose last turn failed", async () => {
  const { w, rotate, calls } = await ready();
  w.threads.get("thr_main")!.status = "error";
  expect(await rotate()).toEqual({ newThreadId: "thr_new1" });
  expect(calls("threads.archive")).toHaveLength(1);
});

describe("an obstacle after the spawn", () => {
  type Ready = Awaited<ReturnType<typeof ready>>;
  it.each<[string, Parameters<typeof world>[0], (r: Ready) => void, RegExp]>([
    ["the new thread failed to start", { spawnStatus: "error" }, () => {}, /new conversation thr_new1 failed to start\. Archive it to resume rotation\./],
    ["the new thread has not started in time", { spawnStatus: "starting" }, () => {}, /thr_new1 has not started in time\. Archive it/],
    ["an automation cannot follow", {}, ({ w }) => void (w.failures.update = new Error("target not runnable")), /heartbeat: target not runnable\)\. Archive it, or move its automations, to resume rotation\./],
    ["a child got work during the hold", { spawnStatus: "starting" }, ({ w }) => void (w.taps.spawned = (id) => {
      w.thread("thr_child", { parentThreadId: "thr_main", status: "active" });
      status(w, id, "idle");
    }), /Child thr_child is active\. Archive it when that work is done/],
    ["a held message cannot move", { spawnStatus: "starting" }, ({ w }) => void (w.taps.spawned = (id) => {
      w.queue("thr_main", { failureReason: "provider down" });
      status(w, id, "idle");
    }), /Messages are queued on thr_main: q1\. Sort that out, then archive it/],
    ["a child of another assistant appears during the hold", { spawnStatus: "starting" }, ({ w }) => void (w.taps.spawned = (id) => {
      othersChild(w);
      status(w, id, "idle");
    }), /Child thr_c belongs to another assistant; archiving thr_main would archive it\. Sort that out, then archive it/],
    // Quiet for a minute, it starts work while its owner is looked up for the last check. On a host with
    // no assistant source the lookup is not cached, so it runs again then.
    ["a quiet child wakes during the last owner lookup", {}, ({ w }) => {
      w.environments.set("env_x", { id: "env_x", projectId: "fleet", hostId: "laptop", path: "/home/x/repo" });
      const child = w.thread("thr_c", { parentThreadId: "thr_main", environmentId: "env_x", updatedAt: Date.now() - 60_000 });
      w.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => {
        if (w.threads.has("thr_new1")) Object.assign(child, { status: "active", updatedAt: Date.now() });
        return w.environments.get(environmentId)!;
      });
    }, /Child thr_c just changed\. Archive it when that work is done/],
    // During the last owner lookup it moves to another assistant's home; bb stamps the move, and the
    // lookup outlasts the quiet time.
    ["a child moves during a slow last owner lookup", {}, ({ w }) => {
      w.environments.set("env_x", { id: "env_x", projectId: "fleet", hostId: "laptop", path: "/home/x/repo" });
      const child = w.thread("thr_c", { parentThreadId: "thr_main", environmentId: "env_x" });
      w.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => {
        if (w.threads.has("thr_new1") && child.environmentId === "env_x") {
          othersChild(w, { updatedAt: Date.now() });
          await settle(FAST.quietMs * 2);
        }
        return w.environments.get(environmentId)!;
      });
    }, /Child thr_c just changed\. Archive it when that work is done/],
    ["the archive call fails", {}, ({ w }) => w.harness.sdk.stub("threads.archive", async () => { throw new Error("archive refused"); }), /kept live: archive refused\. Archive it to resume rotation\./],
  ])("stops when %s: the old thread stays live, the warning says what to do, nothing retries", async (_name, options, arrange, warning) => {
    const r = await ready(options, { runnableMs: 100, retryMs: 50 });
    arrange(r);
    const result = await r.rotate();
    expect(result.newThreadId).toBe("thr_new1");
    expect(result.warning).toMatch(new RegExp(`^Old conversation thr_main kept live: `));
    expect(result.warning).toMatch(warning);
    expect(r.svc.state(IDENTITY)).toMatchObject({ main: "thr_new1", previous: ["thr_main"] });
    expect(r.svc.state(IDENTITY).warnings.at(-1)!.text).toBe(result.warning);
    expect(r.svc.holds.size).toBe(0);
    await settle(150);
    expect(r.w.threads.get("thr_main")!.archivedAt).toBeNull();
    expect(r.calls("threads.spawn")).toHaveLength(1);
  });
});

describe("an old thread kept live", () => {
  async function kept() {
    const r = await ready();
    r.w.failures.update = new Error("target not runnable");
    await r.rotate();
    return r;
  }

  it("is still logged, and holds rotation back with one warning until it is archived", async () => {
    const { w, svc, calls } = await kept();
    w.say("thr_main", "still here");
    svc.onEvents("thr_main");
    await vi.waitFor(() => expect(svc.chat(IDENTITY).msgs.at(-1)!.text).toBe("still here"));

    svc.clearWarnings(IDENTITY);
    w.say("thr_new1", "one");
    w.say("thr_new1", "two");
    w.turnEnd("thr_new1");
    w.usage.set("thr_new1", { usedTokens: 90, modelContextWindow: 100 });
    await svc.onIdle("thr_new1");
    await svc.onIdle("thr_new1");
    expect(calls("threads.spawn")).toHaveLength(1);
    expect(svc.state(IDENTITY).warnings.map((x) => x.text)).toEqual([
      "rotation waits: Old conversation thr_main is still live from an earlier rotation. Archive it to resume rotation.",
    ]);
    await expect(handover(svc, { identity: IDENTITY, oldThreadId: "thr_new1" })).rejects.toThrow(/thr_main is still live/);
  });

  it("leaves the log when archived, only after its last events are in", async () => {
    const { w, svc } = await kept();
    w.say("thr_main", "last words");
    w.threads.get("thr_main")!.archivedAt = Date.now();
    w.failures.events = new Error("server busy");
    await svc.onGone("thr_main", "archived");
    expect(svc.state(IDENTITY).previous).toEqual(["thr_main"]);
    // The next start drains it instead.
    delete w.failures.events;
    await svc.dispose();
    const restarted = w.service();
    await restarted.start();
    expect(restarted.state(IDENTITY).previous).toEqual([]);
    expect(restarted.chat(IDENTITY).msgs.at(-1)!.text).toBe("last words");
  });

  it.each(["its timer", "the next catch-up"])("drains an archived old thread again on %s after a failed drain", async (trigger) => {
    const { w, svc } = await kept();
    w.say("thr_main", "last words");
    w.threads.get("thr_main")!.archivedAt = Date.now();
    w.failures.events = new Error("server busy");
    await svc.onGone("thr_main", "archived");
    expect(svc.state(IDENTITY).previous).toEqual(["thr_main"]);
    delete w.failures.events;
    if (trigger === "the next catch-up") svc.onEvents("thr_new1");
    await vi.waitFor(() => expect(svc.state(IDENTITY).previous).toEqual([]));
    expect(svc.chat(IDENTITY).msgs.at(-1)!.text).toBe("last words");
  });

  it("lets memory on drop an old thread archived while memory was off", async () => {
    const { w, svc } = await kept();
    svc.off(IDENTITY);
    await w.bb.sdk.threads.archive({ threadId: "thr_main" });
    await svc.onGone("thr_main", "archived");
    await svc.on("thr_new1");
    expect(svc.state(IDENTITY)).toMatchObject({ on: true, main: "thr_new1", previous: [] });
  });

  it("leaves the log when deleted while the plugin was down", async () => {
    const { w, svc } = await kept();
    w.threads.get("thr_main")!.deletedAt = Date.now();
    await svc.dispose();
    const restarted = w.service();
    await restarted.start();
    expect(restarted.state(IDENTITY)).toMatchObject({ main: "thr_new1", previous: [] });
  });
});

it("finishes a handover that memory off arrived in the middle of", async () => {
  const { w, svc, rotate, calls } = await ready({ spawnStatus: "starting" }, { runnableMs: 1000 });
  const moving = rotate();
  await vi.waitFor(() => expect(w.threads.has("thr_new1")).toBe(true));
  svc.off(IDENTITY);
  status(w, "thr_new1", "idle");
  await moving;
  expect(svc.state(IDENTITY)).toMatchObject({ on: false, main: "thr_new1", previous: [] });
  expect(calls("threads.archive")).toHaveLength(1);
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
    await vi.waitFor(() => expect(w.threads.has("thr_new1")).toBe(true));
    expect(await dispatch("thr_main")).toEqual({ action: "wait", reason: "Moving to a new conversation" });
    expect(await dispatch("thr_other")).toEqual({ action: "proceed" });
    w.queue("thr_main", { content: [{ type: "text", text: "sent during the move", mentions: [] }] });
    status(w, "thr_new1", "idle");
    expect(await rotating).toMatchObject({ exitCode: 0, stdout: "Rotated to thr_new1\n" });
    expect(await dispatch("thr_main")).toEqual({ action: "proceed" });
    expect(w.harness.inspection.recheckCount).toBeGreaterThan(0);
    expect(w.queued.get("thr_new1")!.map((r) => r.content)).toEqual([[{ type: "text", text: "sent during the move", mentions: [] }]]);
  });

  it.each(["archived", "deleted"] as const)("resumes rotation once the user has %s an old thread a stopped handover kept", async (fate) => {
    const w = await loaded();
    w.failures.update = new Error("target not runnable");
    expect((await w.harness.behavior.runCli(["rotate", "thr_main"])).stdout).toMatch(/kept live/);
    const status = async () => (await w.harness.behavior.runCli(["memory", "status", "thr_new1"])).stdout;
    expect(await status()).toMatch(/^kept live: thr_main /m);
    const old = w.threads.get("thr_main")!;
    if (fate === "archived") old.archivedAt = Date.now();
    else old.deletedAt = Date.now();
    await w.harness.behavior.emitThreadEvent(`thread.${fate}`, { thread: old });
    expect(await status()).not.toMatch(/^kept live/m);
  });

  it("refuses `rotate` over a child of another assistant, but a composed move archives it, as the user chose it", async () => {
    const w = await loaded();
    othersChild(w);
    expect(await w.harness.behavior.runCli(["rotate", "thr_main"])).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/Child thr_c belongs to another assistant/) });
    expect(w.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    const request = {
      replaceThreadId: "thr_main", title: "Test", destinationHostId: "srv", homePath: w.home,
      request: { projectId: "fleet", providerId: "codex", model: "m-9", reasoningLevel: "low", permissionMode: "full", executionInputSources: {}, environment: {}, input: [{ type: "text", text: "New topic", mentions: [] }] },
    };
    expect(await w.harness.behavior.callRpc("createReplacementThread", request)).toEqual({ newThreadId: "thr_new1" });
    expect(w.threads.get("thr_c")!.archivedAt).not.toBeNull();
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
    await vi.waitFor(async () => expect(await w.harness.behavior.runCli(["recall", "0", "2"], { threadId: "thr_main" })).toMatchObject({ exitCode: 0, stdout: "0+1|user: hello\n1+1|unii: hi\n" }));
    expect(await w.harness.behavior.runCli(["date", "1", "--assistant", "thr_main"])).toMatchObject({ exitCode: 0, stdout: `${spokenDate(localIso(w.events.get("thr_main")!.at(-1)!.createdAt))}\n` });
    expect(await w.harness.behavior.runCli(["recall", "0"])).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/--assistant/) });
    expect(await w.harness.behavior.runCli(["recall", "5", "1"], { threadId: "thr_main" })).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/no line 5\+1/) });
  });
});
