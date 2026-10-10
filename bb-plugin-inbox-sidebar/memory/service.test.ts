import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { IDENTITY, settle, world } from "./world";

const worlds: Array<ReturnType<typeof world>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of worlds.splice(0)) await w.dispose();
});
const start = (...args: Parameters<typeof world>) => {
  const w = world(...args);
  worlds.push(w);
  return w;
};

/** `claude -p` that never answers, until killed. */
const hanging = (() => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) as any;
  child.stdin = Object.assign(new EventEmitter(), { end: () => {} });
  child.kill = () => setImmediate(() => child.emit("close", null, "SIGKILL"));
  return child;
}) as unknown as typeof spawn;

const command = { type: "commandExecution", id: "c1", command: "ls", cwd: "/", aggregatedOutput: "a.txt", exitCode: 0, approvalStatus: null, status: "completed" };

it("logs a command's call and output from one event, and after a crash between them only the missing output", async () => {
  const w = start();
  let svc = w.service();
  await svc.on("thr_main");
  const said = w.say("thr_main", "list files");
  await svc.catchUp(IDENTITY, "thr_main");
  const dir = svc.dir(IDENTITY);
  const view = fs.readFileSync(path.join(dir, "view.json"));
  const ran = w.emit("thr_main", "item/completed", { item: command });
  await svc.catchUp(IDENTITY, "thr_main");
  const logged = [
    ["user", "list files", `thread:thr_main:${said.seq}#0`],
    ["tool", "$ ls", `thread:thr_main:${ran.seq}#0`],
    ["echo", "a.txt\nexit 0", `thread:thr_main:${ran.seq}#1`],
  ];
  expect(svc.chat(IDENTITY).msgs.map((m) => [m.kind, m.text, m.src])).toEqual(logged);
  svc.dispose();

  // The crash: the echo and the view save never reached the disk.
  const [file] = fs.readdirSync(path.join(dir, "main")).map((f) => path.join(dir, "main", f));
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, 2).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "view.json"), view);

  svc = w.service();
  await svc.start();
  expect(svc.chat(IDENTITY).msgs.map((m) => [m.kind, m.text, m.src])).toEqual(logged);
});

it("rotates once at the idle after a completed turn over the threshold, never on an interrupted one, under it, or after the bootstrap alone", async () => {
  const w = start();
  const svc = w.service();
  await svc.on("thr_main");
  // A fresh session whose only request is its hidden bootstrap: with a low threshold it must not rotate on and on.
  w.emit("thr_main", "client/turn/requested", { initiator: "user", senderThreadId: null, input: [{ type: "text", text: "<chat>…</chat>", visibility: "agent-only" }] });
  w.reply("thr_main", "ready");
  w.turnEnd("thr_main");
  w.usage.set("thr_main", { usedTokens: 90_000, modelContextWindow: 100_000 });
  await svc.onIdle("thr_main");
  w.say("thr_main", "and now?");
  w.turnEnd("thr_main", "interrupted");
  await svc.onIdle("thr_main");
  w.turnEnd("thr_main");
  w.usage.set("thr_main", { usedTokens: 50_000, modelContextWindow: 100_000 });
  await svc.onIdle("thr_main");
  expect(w.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);

  w.usage.set("thr_main", { usedTokens: 56_000, modelContextWindow: 100_000 });
  // Two wake-ups for one idle, as the event stream and the idle event can both bring.
  await Promise.all([svc.onIdle("thr_main"), svc.onIdle("thr_main")]);
  await svc.onIdle("thr_main");
  expect(w.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(svc.state(IDENTITY)).toMatchObject({ main: "thr_new1", previous: [] });
  expect(w.threads.get("thr_main")!.archivedAt).not.toBeNull();
  expect(w.automations[0].automation.execution.targetThreadId).toBe("thr_new1");
  expect(svc.state(IDENTITY).warnings).toEqual([]);

  // One turn the user typed is enough: memory turned on in a thread with a single long turn still rotates.
  w.say("thr_new1", "one long request");
  w.turnEnd("thr_new1");
  w.usage.set("thr_new1", { usedTokens: 90_000, modelContextWindow: 100_000 });
  await svc.onIdle("thr_new1");
  expect(svc.state(IDENTITY).main).toBe("thr_new2");
});

it("stops waiting for summaries when the user starts another turn, and warns when they never come", async () => {
  const w = start();
  const svc = w.service({ readinessMs: 80, retryMs: 50 }, hanging);
  await svc.on("thr_main");
  w.say("thr_main", "x".repeat(900));
  w.say("thr_main", "y");
  w.turnEnd("thr_main");
  w.usage.set("thr_main", { usedTokens: 90, modelContextWindow: 100 });

  const waiting = svc.onIdle("thr_main");
  await settle(10);
  svc.onActive("thr_main");
  await waiting;
  expect(svc.state(IDENTITY).warnings).toEqual([]);

  await svc.onIdle("thr_main");
  expect(svc.state(IDENTITY).warnings.map((x) => x.text)).toEqual(["rotation skipped: summaries not ready"]);
  expect(w.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  // And tries again on its timer while the chat sits idle, with one warning for the lot.
  const reads = w.harness.inspection.sdk.callsTo("threads.context").length;
  await settle(400);
  expect(w.harness.inspection.sdk.callsTo("threads.context").length).toBeGreaterThan(reads);
  expect(svc.state(IDENTITY).warnings).toHaveLength(1);
});

it("cancels the attempt when a turn starts while the context use is being read", async () => {
  const w = start();
  const svc = w.service();
  await svc.on("thr_main");
  w.say("thr_main", "one");
  w.say("thr_main", "two");
  w.turnEnd("thr_main");
  let answer!: (value: unknown) => void;
  w.harness.sdk.stub("threads.context", () => new Promise((resolve) => (answer = resolve)));
  const idle = svc.onIdle("thr_main");
  await settle();
  svc.onActive("thr_main");
  answer({ usage: { usedTokens: 90, modelContextWindow: 100 } });
  await idle;
  expect(w.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
});

it("tries a rotation a busy moment refused again on its timer, while the chat sits idle after the same turn", async () => {
  const w = start();
  const svc = w.service({ quietMs: 80, retryMs: 120 });
  await svc.on("thr_main");
  w.say("thr_main", "one");
  w.say("thr_main", "two");
  w.turnEnd("thr_main");
  w.usage.set("thr_main", { usedTokens: 90, modelContextWindow: 100 });
  w.thread("thr_child", { parentThreadId: "thr_main", updatedAt: Date.now() });
  await svc.onIdle("thr_main");
  expect(w.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  await settle(250);
  expect(w.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(svc.state(IDENTITY)).toMatchObject({ main: "thr_new1", previous: [] });
});

it("logs background work when bb reports it done", async () => {
  const w = start();
  const svc = w.service();
  await svc.on("thr_main");
  w.emit("thr_main", "item/backgroundTask/completed", { item: { type: "backgroundTask", id: "b", status: "completed", taskType: "shell", description: "build", taskStatus: "completed", skipTranscript: false, summary: "built" } });
  await svc.catchUp(IDENTITY, "thr_main");
  expect(svc.chat(IDENTITY).msgs.map((m) => m.text).at(-1)).toBe("built");
});

it("warns when the harness compacted the chat before it could rotate", async () => {
  const w = start();
  const svc = w.service();
  await svc.on("thr_main");
  w.emit("thr_main", "thread/compacted", {});
  await svc.catchUp(IDENTITY, "thr_main");
  expect(svc.rows()).toEqual([{ identity: IDENTITY, warning: "thr_main compacted before rotation" }]);
  expect(w.harness.inspection.realtimeSignals.some((s) => s.channel === "assistant-memory")).toBe(true);
});

it("imports files and old threads before memory is on, resumably, and refuses once it has been on", async () => {
  const w = start();
  const svc = w.service();
  const file = path.join(w.base, "past.jsonl");
  fs.writeFileSync(file, ["one", "two", "three"].map((text) => JSON.stringify({ kind: "note", text, date: "2026-08-01" })).join("\n") + "\n");
  w.thread("thr_old", { archivedAt: 1 });
  w.say("thr_old", "an old question");
  w.emit("thr_old", "item/completed", { item: command });

  for (let run = 0; run < 2; run++) {
    svc.startImport(IDENTITY, [file, "thr_old"]);
    await settle();
    expect(svc.status(IDENTITY)).toMatch(/messages: 6\n[\s\S]*import: 2\/2 sources\n?/);
  }
  expect(() => svc.startImport(IDENTITY, ["relative.jsonl"])).toThrow(/absolute path/);
  await svc.on("thr_main");
  expect(() => svc.startImport(IDENTITY, [file])).toThrow(/before the first `memory on`/);
});

it("imports one thread into two assistants, each from its start", async () => {
  const w = start();
  const svc = w.service();
  w.thread("thr_old", { archivedAt: 1 });
  w.say("thr_old", "an old question");
  for (const identity of [IDENTITY, "fleet:zz-other"]) {
    svc.startImport(identity, ["thr_old"]);
    await settle();
    expect(svc.chat(identity).msgs.map((m) => m.text)).toEqual(["an old question"]);
  }
});

it("resumes a file import a failed write stopped", async () => {
  const w = start();
  const svc = w.service();
  const file = path.join(w.base, "past.jsonl");
  fs.writeFileSync(file, ["one", "two", "three"].map((text) => JSON.stringify({ kind: "note", text, date: "2026-08-01" })).join("\n") + "\n");
  const append = fs.appendFileSync;
  let writes = 0;
  vi.spyOn(fs, "appendFileSync").mockImplementation((...args: Parameters<typeof append>) => {
    if (++writes === 2) throw new Error("disk full");
    return append(...args);
  });
  svc.startImport(IDENTITY, [file]);
  await settle();
  expect(svc.state(IDENTITY).import).toMatchObject({ done: 0, error: "disk full" });
  svc.startImport(IDENTITY, [file]);
  await settle();
  expect(svc.state(IDENTITY).import).toMatchObject({ done: 1, error: null });
  expect(svc.chat(IDENTITY).msgs.map((m) => m.text)).toEqual(["one", "two", "three"]);
});
