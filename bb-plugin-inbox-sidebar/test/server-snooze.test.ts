import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { boardRpcContract } from "../server";

const HOUR = 60 * 60 * 1_000;

type Host = ReturnType<typeof createFakePluginHost>;
let host: Host;

afterEach(async () => {
  await host.harness.lifecycle.dispose();
});

/** A loaded plugin over threads with the given parents (id → parent id). */
function load(parents: Record<string, string | null> = {}) {
  host = createFakePluginHost({ pluginId: "inbox-sidebar" });
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    if (!(threadId in parents)) throw new Error(`thread ${threadId} not found`);
    return makeThreadResponse({ id: threadId, parentThreadId: parents[threadId] ?? null });
  });
  plugin(host.bb);
  const call = (method: string, input: unknown) =>
    host.harness.behavior.callRpc(method, input);
  const rows = async () =>
    boardRpcContract.listOverrides.output.parse(await call("listOverrides", {})).rows;
  const question = (threadId: string, createdAt = Date.now()) =>
    host.harness.emitThreadEvent("interaction.pending", {
      thread: makeThreadResponse({ id: threadId, parentThreadId: parents[threadId] ?? null }),
      interaction: { id: `int-${threadId}`, threadId, createdAt } as never,
    });
  return { call, rows, question };
}

const isAwake = (row: { override: string; until?: number } | undefined) =>
  row?.override === "snoozed" && row.until! <= Date.now();

describe("snooze store", () => {
  it("refuses a wake time that has already passed", async () => {
    const { call, rows } = load();
    await expect(call("snooze", { threadId: "t", until: Date.now() - 1 })).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  it("keeps one row per thread: settling a snoozed thread replaces the snooze", async () => {
    const { call, rows } = load();
    await call("snooze", { threadId: "t", until: Date.now() + HOUR });
    await call("settle", { threadId: "t" });
    expect(await rows()).toMatchObject([{ threadId: "t", override: "settled" }]);
    expect((await rows())[0]).not.toHaveProperty("until");
  });

  it("ignores a late acknowledgement once the thread was snoozed again", async () => {
    const { call, rows } = load();
    await call("snooze", { threadId: "t", until: Date.now() + HOUR });
    await call("wake", { threadId: "t" });
    const [woken] = await rows();
    const stale = (woken as { until: number }).until;
    const fresh = Date.now() + 2 * HOUR;
    await call("snooze", { threadId: "t", until: fresh });

    await call("acknowledgeWake", { threadId: "t", until: stale });
    expect(await rows()).toMatchObject([{ override: "snoozed", until: fresh }]);
  });

  it("hands an acknowledged wake back as active", async () => {
    const { call, rows } = load();
    await call("snooze", { threadId: "t", until: Date.now() + HOUR });
    await call("wake", { threadId: "t" });
    const until = ((await rows())[0] as { until: number }).until;
    await call("acknowledgeWake", { threadId: "t", until });
    expect(await rows()).toMatchObject([{ threadId: "t", override: "active" }]);
  });
});

describe("early wake", () => {
  it("wakes a snoozed thread on a new question, and its snoozed root on a subagent's", async () => {
    const { call, rows, question } = load({ root: null, child: "root", lone: null });
    await call("snooze", { threadId: "lone", until: Date.now() + HOUR });
    await call("snooze", { threadId: "root", until: Date.now() + HOUR });

    await question("lone");
    await question("child");

    const byId = new Map((await rows()).map((row) => [row.threadId, row]));
    expect(isAwake(byId.get("lone"))).toBe(true);
    expect(isAwake(byId.get("root"))).toBe(true);
  });

  it("leaves unrelated snoozes, settled threads, and already-woken ones alone", async () => {
    const { call, rows, question } = load({ asleep: null, other: null, done: null });
    const until = Date.now() + HOUR;
    await call("snooze", { threadId: "asleep", until });
    await call("settle", { threadId: "done" });

    await question("other");
    await question("done");

    const byId = new Map((await rows()).map((row) => [row.threadId, row]));
    expect(byId.get("asleep")).toMatchObject({ override: "snoozed", until });
    expect(byId.get("done")).toMatchObject({ override: "settled" });
  });

  // Events reach the plugin late. A question that was already open when the
  // user snoozed is the case the snooze exists for; it must not undo it.
  it("does not wake on a question that arrived before the snooze", async () => {
    const { call, rows, question } = load({ t: null });
    const askedAt = Date.now() - 1_000;
    const until = Date.now() + HOUR;
    await call("snooze", { threadId: "t", until });

    await question("t", askedAt);
    expect(await rows()).toMatchObject([{ override: "snoozed", until }]);
  });

  it("still wakes the thread itself when an ancestor lookup fails", async () => {
    // "orphan" names a parent the host cannot find.
    const { call, rows, question } = load({ orphan: "gone" });
    await call("snooze", { threadId: "orphan", until: Date.now() + HOUR });

    const { errors } = await question("orphan");
    expect(errors).toEqual([]);
    expect(isAwake((await rows())[0])).toBe(true);
  });

  it("wakes on a failure too", async () => {
    const { call, rows } = load({ t: null });
    await call("snooze", { threadId: "t", until: Date.now() + HOUR });
    await host.harness.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "t", updatedAt: Date.now() + 1 }),
      error: "boom",
    });
    expect(isAwake((await rows())[0])).toBe(true);
  });
});
