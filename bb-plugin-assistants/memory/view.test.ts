import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";
import { IDENTITY, settle, world } from "./world";

/** `claude -p` that never answers, until killed: summaries stall. */
const hanging = (() => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) as any;
  child.stdin = Object.assign(new EventEmitter(), { end: () => {} });
  child.kill = () => setImmediate(() => child.emit("close", null, "SIGKILL"));
  return child;
}) as unknown as typeof spawn;

const worlds: Array<ReturnType<typeof world>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of worlds.splice(0)) await w.dispose();
});

describe("bb assistants memory view", () => {
  it("gives the snapshot to the assistant's main chat in its home only, never to a helper or a nested run", async () => {
    const w = world();
    worlds.push(w);
    plugin(w.bb);
    await settle();
    const view = (threadId?: string, home = w.home) => w.harness.behavior.runCli(["memory", "view", "--home", home], threadId === undefined ? {} : { threadId });
    w.say("thr_main", "hello");
    expect(await view("thr_main")).toMatchObject({ exitCode: 0, stdout: "" });

    expect(await w.harness.behavior.runCli(["memory", "on", "thr_main"])).toMatchObject({ exitCode: 0 });
    w.thread("thr_helper", { parentThreadId: "thr_main" });
    w.thread("thr_homeless", { environmentId: null });
    await vi.waitFor(async () => expect((await view("thr_main")).stdout).toMatch(/<chat>\n0\+1\|user: hello\n<\/chat>/));
    const { stdout } = await view("thr_main");
    expect(stdout).toMatch(/snapshot of thread thr_main .* covers its first\n1 messages/s);
    expect(stdout).not.toMatch(/Carry on/);
    for (const caller of ["thr_helper", "thr_homeless", undefined]) {
      expect(await view(caller)).toMatchObject({ exitCode: 0, stdout: "" });
    }
    // A `claude` the main chat starts in another folder inherits its thread id, not its home.
    expect(await view("thr_main", "/home/someone/Developer/repo")).toMatchObject({ exitCode: 0, stdout: "" });
  });

  it("refuses a snapshot too big to read while summaries are stalled", async () => {
    const w = world();
    worlds.push(w);
    const svc = w.service({}, hanging);
    await svc.on("thr_main");
    for (let i = 0; i < 600; i++) w.say("thr_main", `${i} ${"x".repeat(300)}`);
    await expect(svc.snapshot(IDENTITY, "thr_main")).rejects.toThrow(/over 128000/);
  });
});
