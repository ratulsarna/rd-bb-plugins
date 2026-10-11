import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { type EventRow, recordsOf, spokenDate } from "./history";
import { Chat } from "./tree";

let seq = 0;
const at = Date.UTC(2026, 8, 1, 4, 30);
const turn = (data: Record<string, unknown>): EventRow => ({ seq: ++seq, createdAt: at, type: "client/turn/requested", data: { initiator: "user", senderThreadId: null, ...data } });
const item = (item: Record<string, unknown>): EventRow => ({ seq: ++seq, createdAt: at, type: "item/completed", data: { item: { id: `i${seq}`, status: "completed", ...item } } });
const records = (rows: EventRow[]) => rows.flatMap(recordsOf).map(({ kind, text }) => [kind, text]);

it("keeps the user's words but never the agent-only view the chat started with", () => {
  expect(records([
    turn({ input: [
      { type: "text", text: "<chat>\n0+1|user: hi\n</chat>", visibility: "agent-only" },
      { type: "text", text: "Where were we?" },
      { type: "localFile", path: "/tmp/notes.txt", name: "notes.txt" },
    ] }),
    // A rotation with no composer text leaves nothing to log.
    turn({ input: [{ type: "text", text: "<chat>\n</chat>", visibility: "agent-only" }] }),
  ])).toEqual([["user", "Where were we?\n[file: notes.txt]"]]);
});

it("logs a side thread's report as work, and grouped sends one message each, in order", () => {
  expect(records([
    turn({ initiator: "agent", senderThreadId: "thr_side", input: [{ type: "text", text: "done: 3 files" }] }),
    turn({ initiator: "agent", senderThreadId: "thr_side", input: [{ type: "text", text: "[bb message from thread:thr_side]\n\nok" }] }),
    turn({ input: [], inputGroups: [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]] }),
  ])).toEqual([
    ["work", "[thread:thr_side] done: 3 files"],
    ["work", "[bb message from thread:thr_side]\n\nok"],
    ["user", "first"],
    ["user", "second"],
  ]);
});

it("drops reasoning and a subagent's own transcript but keeps the call that started it", () => {
  expect(records([
    item({ type: "reasoning", summary: ["thinking"], content: [] }),
    item({ type: "delegation", childRef: "agent-1", label: "explore repo", background: false, summary: "found 2 callers" }),
    item({ type: "commandExecution", command: "ls", cwd: "/", aggregatedOutput: "a", exitCode: 0, approvalStatus: null, parentToolCallId: "agent-1" }),
    item({ type: "agentMessage", text: "inner reply", parentToolCallId: "agent-1" }),
    item({ type: "agentMessage", text: "Two callers." }),
  ])).toEqual([
    ["tool", 'delegation {"childRef":"agent-1","label":"explore repo","background":false}'],
    ["echo", "found 2 callers"],
    ["unii", "Two callers."],
  ]);
});

it("logs a background task and a background delegation when bb closes them", () => {
  const done = (type: string, item: Record<string, unknown>): EventRow => ({ seq: ++seq, createdAt: at, type, data: { item: { id: `i${seq}`, status: "completed", ...item } } });
  expect(records([
    done("item/backgroundTask/completed", { type: "backgroundTask", taskType: "shell", description: "run tests", taskStatus: "completed", skipTranscript: false, summary: "12 passed" }),
    done("item/delegation/completed", { type: "delegation", childRef: "a-2", label: "review", background: true, summary: "no findings" }),
  ])).toEqual([
    ["tool", 'backgroundTask {"taskType":"shell","description":"run tests","taskStatus":"completed","skipTranscript":false}'],
    ["echo", "12 passed"],
    ["tool", 'delegation {"childRef":"a-2","label":"review","background":true}'],
    ["echo", "no findings"],
  ]);
});

it("drops a plain successful recall but keeps a failed or compound one", () => {
  const command = (command: string, exitCode: number) =>
    item({ type: "commandExecution", command, cwd: "/", aggregatedOutput: "out", exitCode, approvalStatus: null });
  expect(records([
    command("bb assistants recall 128 4", 0),
    command("bb assistants date 7", 0),
    command("bb assistants recall 3 2", 1),
    command("bb assistants recall 0 1 && rm -rf x", 0),
    command("bb assistants recall 1 $(rm -rf x)", 0),
    // Codex's shell wrapper, with either quotes and with or without a path.
    command("/bin/bash -lc 'bb assistants recall 21 1'", 0),
    command('zsh -c "bb assistants date 7 --assistant thr_a1"', 0),
    command("/bin/bash -lc 'bb assistants recall 0 1 && rm -rf x'", 0),
    command("/bin/bash -lc 'bb assistants recall 3 2'", 1),
    command("./run-tests;/bin/sh -c 'bb assistants recall 21 1'", 0),
  ])).toEqual([
    ["tool", "$ bb assistants recall 3 2"],
    ["echo", "out\nexit 1"],
    ["tool", "$ bb assistants recall 0 1 && rm -rf x"],
    ["echo", "out\nexit 0"],
    ["tool", "$ bb assistants recall 1 $(rm -rf x)"],
    ["echo", "out\nexit 0"],
    ["tool", "$ /bin/bash -lc 'bb assistants recall 0 1 && rm -rf x'"],
    ["echo", "out\nexit 0"],
    ["tool", "$ /bin/bash -lc 'bb assistants recall 3 2'"],
    ["echo", "out\nexit 1"],
    ["tool", "$ ./run-tests;/bin/sh -c 'bb assistants recall 21 1'"],
    ["echo", "out\nexit 0"],
  ]);
});

it("splits each harness's tool calls into the call and its output", () => {
  expect(records([
    // Codex
    item({ type: "fileChange", approvalStatus: null, changes: [{ path: "a.ts", kind: "update", diff: "-a\n+b" }, { path: "b.ts", kind: "add" }] }),
    // Pi and MCP tools
    item({ type: "toolCall", tool: "read", arguments: { path: "x" }, result: { lines: 2 } }),
    item({ type: "toolCall", tool: "write", arguments: {}, error: "denied" }),
    item({ type: "webFetch", url: "https://example.com", prompt: null, pattern: null, resultText: "page" }),
    // Claude Code
    item({ type: "fileRead", path: "/x/README.md" }),
  ])).toEqual([
    ["tool", "edit update a.ts\nedit add b.ts"],
    ["echo", "-a\n+b"],
    ["tool", 'read {"path":"x"}'],
    ["echo", '{"lines":2}'],
    ["tool", "write {}"],
    ["echo", "error: denied"],
    ["tool", "webFetch https://example.com"],
    ["echo", "page"],
    ["tool", 'fileRead {"path":"/x/README.md"}'],
  ]);
});

it("logs a huge tool output as an echo the tree clips head and tail", () => {
  const output = `HEAD${"x".repeat(40_000)}TAIL`;
  const rows = recordsOf(item({ type: "commandExecution", command: "cat big", cwd: "/", aggregatedOutput: output, exitCode: 0, approvalStatus: null }));
  const chat = Chat.open(fs.mkdtempSync(path.join(os.tmpdir(), "history-")));
  for (const r of rows) chat.append(r.kind, r.text, r.date);
  const echo = chat.msgs[1];
  expect(echo.kind).toBe("echo");
  expect(echo.text.startsWith("HEAD")).toBe(true);
  expect(echo.text.endsWith("TAIL\nexit 0")).toBe(true);
  expect(echo.text).toMatch(/characters clipped/);
  expect(echo.date).toMatch(/^2026-09-01T\d\d:\d\d:00[+-]\d\d:\d\d$/);
  chat.close();
});

it("says a date with its zone in words before the stored value, and leaves one without an offset as stored", () => {
  expect(spokenDate("2026-10-10T15:42:49+00:00")).toBe("2026-10-10 15:42 UTC (2026-10-10T15:42:49+00:00)");
  expect(spokenDate("2026-08-17T10:30:00+05:30")).toBe("2026-08-17 10:30 UTC+05:30 (2026-08-17T10:30:00+05:30)");
  expect(spokenDate("2026-03-01T08:05:00-04:00")).toBe("2026-03-01 08:05 UTC-04:00 (2026-03-01T08:05:00-04:00)");
  expect(spokenDate("2026-08-01")).toBe("2026-08-01");
});

it("logs nothing for bb's manual compact, but keeps a message that only mentions it or only types it", () => {
  /** bb's built-in compact command, as the manual compact action sends it. */
  const compact = [{ type: "text", text: "/compact", mentions: [{ start: 0, end: 8, resource: { kind: "command", trigger: "/", name: "compact", source: "command", origin: "builtin", label: "compact", argumentHint: null } }] }];
  expect(records([
    turn({ input: compact }),
    turn({ input: [{ ...compact[0], text: "/compact now please" }] }),
    // Sent through the API, with no command mention.
    turn({ input: [{ type: "text", text: "/compact" }] }),
  ])).toEqual([["user", "/compact now please"], ["user", "/compact"]]);
});
