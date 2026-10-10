import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Summarizer } from "./summarize";
import { Chat } from "./tree";

type Reply = { out?: string; code?: number };
type Call = { prompt: string; args: string[]; env: NodeJS.ProcessEnv; killed: boolean };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A `claude -p` stand-in: `script` answers each call by its prompt, and may never answer. */
function harness(script: (prompt: string, call: number) => Reply | Promise<Reply>, timeoutMs?: number) {
  const calls: Call[] = [];
  let live = 0;
  let peak = 0;
  const spawn = ((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) as any;
    const call: Call = { prompt: "", args, env: opts.env, killed: false };
    calls.push(call);
    peak = Math.max(peak, ++live);
    let closed = false;
    const close = (code: number | null, signal: string | null) => {
      if (closed) return;
      closed = true;
      live--;
      child.emit("close", code, signal);
    };
    child.kill = () => {
      call.killed = true;
      setImmediate(() => close(null, "SIGKILL"));
      return true;
    };
    child.stdin = Object.assign(new EventEmitter(), {
      end: (prompt: string) => {
        call.prompt = prompt;
        void Promise.resolve(script(prompt, calls.length)).then(({ out = "", code = 0 }) => {
          if (closed) return;
          child.stdout.emit("data", out);
          close(code, null);
        });
      },
    });
    return child;
  }) as unknown as typeof nodeSpawn;
  const summarizer = new Summarizer({
    scratch: fs.mkdtempSync(path.join(os.tmpdir(), "summarize-scratch-")),
    log: () => {},
    spawn,
    timeoutMs,
  });
  cleanups.push(() => summarizer.dispose());
  return { summarizer, calls, peak: () => peak };
}

function chat(): Chat {
  const c = Chat.open(fs.mkdtempSync(path.join(os.tmpdir(), "summarize-chat-")));
  cleanups.push(() => c.close());
  return c;
}

const long = (tag: string) => `${tag} `.padEnd(900, "m");
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
function deferred() {
  let resolve!: (reply: Reply) => void;
  return { promise: new Promise<Reply>((r) => (resolve = r)), resolve };
}

it("retries a line that is too long with the cut, keeps the one that fits, and runs on the subscription login", async () => {
  Object.assign(process.env, { ANTHROPIC_API_KEY: "key", CLAUDE_CODE_OAUTH_TOKEN: "token", BB_THREAD_ID: "thr_x" });
  cleanups.push(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.BB_THREAD_ID;
  });
  const h = harness((_p, n) => ({ out: n === 1 ? "y".repeat(600) : "short line\n" }));
  const c = chat();
  h.summarizer.add("a", c);
  c.append("echo", long("one"), "2026-09-01");
  expect(await h.summarizer.waitUntil(c, () => c.unsummarized === 0, 2000)).toBe(true);
  expect(c.viewLines()).toEqual(["0+1|short line"]);
  expect(h.calls[1].prompt).toContain(h.calls[0].prompt);
  expect(h.calls[1].prompt).toMatch(/Too long: your line is 600 bytes/);
  const env = h.calls[0].env;
  expect(Object.keys(env).filter((k) => /^(ANTHROPIC_|BB_)|^CLAUDE_CODE_OAUTH_TOKEN$/.test(k))).toEqual([]);
  expect(env.PATH).toBe(process.env.PATH);
  expect(h.calls[0].args).toEqual(expect.arrayContaining(["-p", "--tools", "", "--model", "haiku"]));
});

it("keeps the shortest of 5 lines that are all too long", async () => {
  const sizes = [700, 550, 900, 600, 800];
  const h = harness((_p, n) => ({ out: String(n).padEnd(sizes[n - 1], "z") }));
  const c = chat();
  h.summarizer.add("a", c);
  c.append("echo", long("one"), "2026-09-01");
  expect(await h.summarizer.waitUntil(c, () => c.unsummarized === 0, 2000)).toBe(true);
  expect(h.calls).toHaveLength(5);
  expect(c.zoom(0, 1)).toMatch(/^echo: one/);
  expect(c.viewLines()[0]).toBe(`0+1|${"2".padEnd(550, "z")}`);
});

it("fails a node on an empty reply and retries it with the next message", async () => {
  const h = harness((prompt) => ({ out: /compress message 0/.test(prompt) && h.calls.length === 1 ? "  \n" : "a line" }));
  const c = chat();
  h.summarizer.add("a", c);
  c.append("echo", long("one"), "2026-09-01");
  h.summarizer.pump();
  await settle();
  expect([c.failures, c.inFlight, c.unsummarized]).toEqual([1, 0, 1]);
  c.append("user", "next", "2026-09-01");
  h.summarizer.pump();
  await settle();
  expect([c.failures, c.unsummarized]).toEqual([0, 0]);
  expect(c.viewLines()[0]).toBe("0+1|a line");
});

it("kills a hung call at the timeout and frees its slot for the next node", async () => {
  const h = harness((_p, n) => (n === 1 ? new Promise<Reply>(() => {}) : { out: "a line" }), 30);
  h.summarizer.pool = 1;
  const c = chat();
  h.summarizer.add("a", c);
  c.append("echo", long("one"), "2026-09-01");
  c.append("echo", long("two"), "2026-09-01");
  h.summarizer.pump();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(h.calls[0].killed).toBe(true);
  expect(h.calls).toHaveLength(2);
  expect(h.peak()).toBe(1);
  expect([c.failures, c.inFlight, c.unsummarized]).toEqual([1, 0, 1]);
  expect(c.viewLines()[1]).toBe("1+1|a line");
});

it("holds two chats to one pool, and a long import cannot starve the other chat", async () => {
  const gates: Array<ReturnType<typeof deferred>> = [];
  const h = harness(() => {
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });
  h.summarizer.pool = 2;
  const importing = chat();
  const live = chat();
  h.summarizer.add("import", importing);
  h.summarizer.add("live", live);
  for (let i = 0; i < 6; i++) importing.append("echo", long(`import ${i}`), "2026-09-01");
  h.summarizer.pump();
  expect(h.calls).toHaveLength(2);
  live.append("echo", long("live"), "2026-09-01");
  h.summarizer.pump();
  expect(h.calls).toHaveLength(2);
  // One import call ends: the free slot goes to the live chat, whose turn is next.
  gates[0].resolve({ out: "line" });
  await settle();
  expect(h.calls).toHaveLength(3);
  expect(h.calls[2].prompt).toMatch(/echo: live/);
  for (let k = 0; k < 20 && importing.unsummarized + live.unsummarized > 0; k++) {
    for (const gate of gates.splice(0)) gate.resolve({ out: "line" });
    await settle();
  }
  expect(h.peak()).toBe(2);
  expect([importing.unsummarized, live.unsummarized]).toEqual([0, 0]);
  expect(h.calls.filter((call) => /echo: live/.test(call.prompt))).toHaveLength(1);
});

it("lets a waiting chat through when another chat frees the only slot, before its deadline", async () => {
  const gate = deferred();
  const h = harness((prompt) => (/echo: a/.test(prompt) ? gate.promise : { out: "b line" }));
  h.summarizer.pool = 1;
  const a = chat();
  const b = chat();
  h.summarizer.add("a", a);
  h.summarizer.add("b", b);
  a.append("echo", long("a"), "2026-09-01");
  h.summarizer.pump();
  b.append("echo", long("b"), "2026-09-01");
  setTimeout(() => gate.resolve({ out: "a line" }), 30);
  const started = Date.now();
  expect(await h.summarizer.waitUntil(b, () => b.unsummarized === 0, 2000)).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(b.viewLines()).toEqual(["0+1|b line"]);
});

it("retries a sole failed leaf inside the wait, with no new message", async () => {
  const h = harness((_p, n) => ({ out: n === 1 ? "" : "a line" }));
  const c = chat();
  h.summarizer.add("a", c);
  c.append("echo", long("one"), "2026-09-01");
  expect(await h.summarizer.waitUntil(c, () => c.unsummarized === 0, 2000)).toBe(true);
  expect(c.T).toBe(1);
  expect(h.calls).toHaveLength(2);
});

it("retries a failed first leaf that blocks the window instead of waiting forever behind it", async () => {
  const h = harness((prompt, n) => ({ out: n === 1 && /compress message 0/.test(prompt) ? "" : "a line" }));
  h.summarizer.pool = 1;
  const c = chat();
  c.tune({ pool: 1 });
  h.summarizer.add("a", c);
  c.append("echo", long("one"), "2026-09-01");
  c.append("echo", long("two"), "2026-09-01");
  expect(await h.summarizer.waitUntil(c, () => c.unsummarized === 0, 2000)).toBe(true);
  expect(h.calls.map((call) => /compress message (\d+)/.exec(call.prompt)![1])).toEqual(["0", "0", "1"]);
});

it("leaves the chat alone when a call finishes just as the plugin reloads", async () => {
  const reply = deferred();
  const h = harness(() => reply.promise);
  const c = chat();
  const writes = [vi.spyOn(c, "done"), vi.spyOn(c, "fail")];
  h.summarizer.add("a", c);
  c.append("echo", long("one"), "2026-09-01");
  h.summarizer.pump();
  await settle();
  reply.resolve({ out: "a line" });
  h.summarizer.dispose();
  await settle();
  for (const write of writes) expect(write).not.toHaveBeenCalled();
});
