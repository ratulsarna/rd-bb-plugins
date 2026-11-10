import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";
import { settle, world } from "./world";

const worlds: Array<ReturnType<typeof world>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of worlds.splice(0)) await w.dispose();
});

describe("bb assistants memory view", () => {
  it("gives the snapshot to the assistant's main chat only, never to a helper in its home", async () => {
    const w = world();
    worlds.push(w);
    plugin(w.bb);
    await settle();
    const view = (threadId?: string) => w.harness.behavior.runCli(["memory", "view"], threadId === undefined ? {} : { threadId });
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
  });
});
