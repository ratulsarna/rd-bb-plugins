import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, vi } from "vitest";
import { bytes, Chat, LINE, mergeAt, pickMerge, type Ref, tooLong } from "./tree";

// Taelin's rollback push (rollback_state_list.js), copied from the gist.
type States = { keep: number; life: number; state: number; older: States | null } | null;
function push(s: number, states: States): NonNullable<States> {
  if (states === null) return { keep: 0, life: 0, state: s, older: null };
  const { keep, life, state, older } = states;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) return { keep: 0, life: 0, state: s, older: { keep: 0, life: life - 1, state, older } };
  return { keep: 0, life, state: s, older: push(state, older) };
}

function starts(states: States): number[] {
  const out: number[] = [];
  for (let s = states; s; s = s.older) out.unshift(s.state);
  return out;
}

/** Feed t = 0..last into push and into a view held to push's length, merging with `pick`. */
function agreement(pick: (v: Ref[], T: number) => number, last: number): { matches: number; firstMiss?: number } {
  let states: States = null;
  const view: Ref[] = [];
  let matches = 0;
  let firstMiss: number | undefined;
  for (let t = 0; t <= last; t++) {
    states = push(t, states);
    view.push([0, t]);
    const want = starts(states);
    while (view.length > want.length) mergeAt(view, pick(view, t + 1));
    const got = view.map(([l, i]) => i * 2 ** l);
    if (got.join() === want.join()) matches++;
    else firstMiss ??= t;
  }
  return { matches, firstMiss };
}

it("due merge order matches Taelin's push at every t = 0..20,000", () => {
  const r = agreement((v, T) => pickMerge(v, T, () => true), 20_000);
  assert.equal(r.firstMiss, undefined, `first mismatch at t=${r.firstMiss}`);
  assert.equal(r.matches, 20_001);
});

it("measuring from a pair's first message breaks the order, as the gist says", () => {
  // The same harness must catch the gist's known bug, or the test above proves nothing.
  const byFirst = (v: Ref[], T: number) => {
    let best = -1;
    let bestDue = -Infinity;
    for (let k = 0; k + 1 < v.length; k++) {
      const [l, i] = v[k];
      if (l !== v[k + 1][0] || i % 2 !== 0) continue;
      const due = (T - i * 2 ** l) / 2 ** l;
      if (due > bestDue) [best, bestDue] = [k, due];
    }
    return best;
  };
  const r = agreement(byFirst, 20_000);
  assert.equal(r.firstMiss, 9); // T = 10 messages: the gist's example
  assert.equal(r.matches, 481); // the gist's count
});

/** A fake compactor: deterministic lines of near-full length, so the view really fills. */
function fakeLine(prompt: string): string {
  const task = prompt.split("</chat>").at(-1)!;
  const id = /compress message (\d+)|merge lines (\S+)/.exec(task)!;
  return `summary of ${id[1] ?? id[2]} `.padEnd(LINE - 20, "x");
}

function drive(chat: Chat, check: (prompt: string, ref: Ref) => void): void {
  for (let job = chat.take(); job; job = chat.take()) {
    check(job.prompt, job.ref);
    chat.done(job.ref, fakeLine(job.prompt));
  }
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optchat-test-"));
}

const text = (i: number) => (i % 5 === 0 ? `short ${i}` : `message ${i} `.padEnd(900, "m"));

it("view stays in the sawtooth, covers the chat, and compactions only see built lines before their node", async () => {
  const dir = tmp();
  const chat = Chat.open(dir);
  let batches = 0;
  let prev = 0;
  for (let i = 0; i < 3000; i++) {
    chat.append("unii", text(i), "2026-09-01T10:00:00+05:30");
    // Measured as the batch left it: building a pending line later grows the view.
    const { view, cview, shrinking } = chat.viewBytes();
    if (view < prev && !shrinking) {
      batches++;
      assert.ok(view <= 64_000, `a batch stopped at ${view} bytes`);
    }
    prev = view;
    assert.ok(view <= 128_000 + LINE + 20, `view at ${view} bytes`);
    assert.ok(cview <= 32_000 + LINE + 20, `compaction view at ${cview} bytes`);
    drive(chat, (prompt, [l, i]) => {
      const first = i * 2 ** l;
      const limit = l === 0 ? first : (i + 1) * 2 ** l;
      const chatPart = prompt.split("</chat>")[0];
      assert.ok(!chatPart.includes("not summarized"), "compaction view holds an unbuilt line");
      for (const m of chatPart.matchAll(/^(\d+)\+(\d+)\|/gm)) {
        assert.ok(Number(m[1]) + Number(m[2]) <= limit, `line ${m[1]}+${m[2]} is past node ${l}:${i}`);
      }
    });
    const lines = chat.viewLines();
    let next = 0;
    for (const line of lines) {
      const [, id, n] = /^(\d+)\+(\d+)\|/.exec(line)!.map(Number);
      assert.equal(id, next, "view has a gap or overlap");
      next = id + n;
    }
    assert.equal(next, chat.T);
  }
  assert.ok(batches >= 5, `only ${batches} batches`);
  // Every line opens into the two lines it was made from, down to the message itself.
  for (const line of chat.viewLines()) {
    const [, id, n] = /^(\d+)\+(\d+)\|/.exec(line)!.map(Number);
    if (n === 1) {
      assert.equal(chat.zoom(id, 1), `unii: ${text(id)}`);
      continue;
    }
    const halves = chat.zoom(id, n).split("\n").map((x) => /^(\d+)\+(\d+)\|/.exec(x)!.slice(1).map(Number));
    assert.deepEqual(halves, [[id, n / 2], [id + n / 2, n / 2]]);
  }
  assert.throws(() => chat.zoom(3, 2));
  assert.throws(() => chat.zoom(0, 3));
  assert.throws(() => chat.zoom(chat.T, 1));
  await chat.close();
}, 180_000);

it("a restart mid-chat keeps the saved view and finishes the same tree", async () => {
  const steady = Chat.open(tmp());
  const restarted = await (async () => {
    const dir = tmp();
    let chat = Chat.open(dir);
    for (let i = 0; i < 1500; i++) {
      chat.append("echo", text(i), "2026-09-02T10:00:00+05:30");
      // Leave some work unfinished, as a crash would.
      if (i !== 1499) drive(chat, () => {});
    }
    const before = chat.viewLines();
    chat.take(); // in flight when the process dies
    await chat.close();
    chat = Chat.open(dir);
    assert.deepEqual(chat.viewLines(), before, "reopening changed the view");
    return chat;
  })();
  for (let i = 0; i < 1500; i++) {
    steady.append("echo", text(i), "2026-09-02T10:00:00+05:30");
    drive(steady, () => {});
  }
  drive(restarted, () => {});
  for (let i = 1500; i < 2500; i++) {
    for (const chat of [steady, restarted]) {
      chat.append("echo", text(i), "2026-09-02T10:00:00+05:30");
      drive(chat, () => {});
    }
  }
  assert.deepEqual(restarted.viewLines(), steady.viewLines());
  assert.ok(steady.idle() && restarted.idle());
}, 180_000);

it("a failed compaction is tried again at the next message, and the chat is not idle until then", () => {
  // A long message, then two short ones whose joined line is too long: a message job and a merge job.
  for (const kinds of [["echo"], ["user", "user"]] as const) {
    const chat = Chat.open(tmp());
    for (const kind of kinds) chat.append(kind, kind === "echo" ? text(1) : "u".repeat(300), "2026-09-03");
    const job = chat.take()!;
    assert.equal(job.ref[0], kinds.length - 1);
    chat.fail(job.ref);
    assert.equal(chat.take(), undefined);
    assert.equal(chat.idle(), false, `a failed ${kinds.length === 1 ? "message" : "merge"} looks idle`);
    chat.retryFailed();
    assert.deepEqual(chat.take()?.ref, job.ref);
  }
});

it("the too-long retry cuts at 512 bytes without splitting a character", () => {
  const reply = "é".repeat(400); // 800 bytes
  const cut = tooLong(reply).split("\n").at(-1)!.replace("| ← LIMIT", "");
  assert.ok(!cut.includes("�"));
  assert.equal(bytes(cut), 512);
  assert.match(tooLong(reply), /your line is 800 bytes/);
});

it("after a failed write nothing is appended until the chat reads itself back, then the record is logged", async () => {
  const dir = tmp();
  const chat = Chat.open(dir);
  // A directory where the day's log file goes makes the write fail.
  fs.mkdirSync(path.join(dir, "main", "2026-09-05.jsonl"), { recursive: true });
  const src = () => ({ stream: "e", at: 4, n: 0 });
  chat.append("user", "hi", "2026-09-05T10:00:00+05:30", src());
  await assert.rejects(chat.flush());
  fs.rmSync(path.join(dir, "main", "2026-09-05.jsonl"), { recursive: true });
  // A torn line must stay the file's last, so a later write cannot glue a record onto it.
  assert.throws(() => chat.append("user", "hi", "2026-09-05T10:00:00+05:30", src()), /a write failed/);
  await assert.rejects(chat.flush(), /a write failed/);
  chat.reload();
  assert.equal(chat.resumeAt("e"), undefined);
  assert.deepEqual(chat.append("user", "hi", "2026-09-05T10:00:00+05:30", src()), [0]);
  await chat.close();
  assert.deepEqual(Chat.open(dir).msgs.map((m) => m.text), ["hi"]);
});

it("a batch that fails partway saves no view, and reading back finishes it", async () => {
  const dir = tmp();
  const chat = Chat.open(dir);
  chat.append("user", "one", "2026-09-05");
  chat.append("user", "two", "2026-09-05");
  // The log goes out first; the tree file after it fails.
  const treeFile = path.join(dir, "tree", `${new Date().toISOString().slice(0, 10)}.jsonl`);
  fs.mkdirSync(treeFile, { recursive: true });
  await assert.rejects(chat.flush());
  assert.equal(fs.existsSync(path.join(dir, "view.json")), false);
  fs.rmSync(treeFile, { recursive: true });
  chat.reload();
  assert.deepEqual(chat.viewLines(), ["0+1|user: one", "1+1|user: two"]);
  await chat.close();
  const reopened = Chat.open(dir);
  assert.deepEqual(reopened.viewLines(), ["0+1|user: one", "1+1|user: two"]);
  assert.ok(reopened.built([1, 0]));
});

it("a batch that fails partway leaves a log without gaps, whatever files it spans", async () => {
  const dir = tmp();
  const chat = Chat.open(dir);
  chat.append("user", "first", "2026-09-05");
  chat.append("user", "second", "2026-09-06");
  chat.append("user", "third", "2026-09-05");
  const second = path.join(dir, "main", "2026-09-06.jsonl");
  fs.mkdirSync(second, { recursive: true });
  await assert.rejects(chat.flush());
  fs.rmSync(second, { recursive: true });
  chat.reload();
  assert.deepEqual(chat.msgs.map((m) => m.text), ["first"]);
  await chat.close();
  assert.deepEqual(Chat.open(dir).msgs.map((m) => m.text), ["first"]);
});

it("a commit waits for the one before, so the view never lands before the log it shows", async () => {
  const dir = tmp();
  const chat = Chat.open(dir);
  chat.append("echo", text(1), "2026-09-05");
  const job = chat.take()!;
  const append = fs.promises.appendFile;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const spy = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args: Parameters<typeof append>) => {
    if (first) {
      first = false;
      await held;
    }
    return append(...args);
  });
  const logging = chat.flush();
  // A summary lands and the next message arrives while the first commit is still writing.
  chat.done(job.ref, "a line");
  chat.append("user", "next", "2026-09-05");
  const summary = chat.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(path.join(dir, "view.json")), false);
  release();
  await Promise.all([logging, summary]);
  spy.mockRestore();
  const before = chat.viewLines();
  await chat.close();
  assert.deepEqual(Chat.open(dir).viewLines(), before);
});

it.skipIf(!fs.existsSync("/proc/sys/kernel/random/boot_id"))("a lock from another boot is taken over even when its pid is alive now", async () => {
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "lock"), `${process.ppid} ${boot}`);
  assert.throws(() => Chat.open(dir), /owned by process/);
  fs.writeFileSync(path.join(dir, "lock"), `${process.ppid} 00000000-another-boot`);
  await Chat.open(dir).close();
});

it("a write a crash cut short is cut off at open, and a corrupt whole record still fails the open", async () => {
  const dir = tmp();
  let chat = Chat.open(dir);
  chat.append("user", "kept", "2026-09-06");
  await chat.close();
  const file = path.join(dir, "main", "2026-09-06.jsonl");
  fs.appendFileSync(file, '{"i":1,"kind":"user","te');
  chat = Chat.open(dir);
  assert.equal(chat.T, 1);
  chat.append("user", "next", "2026-09-06");
  await chat.close();
  chat = Chat.open(dir);
  assert.deepEqual(chat.msgs.map((m) => m.text), ["kept", "next"]);
  await chat.close();
  fs.appendFileSync(file, "not json\n");
  assert.throws(() => Chat.open(dir), SyntaxError);
});

it("a replay that logs nothing does not retry failed compactions", () => {
  const chat = Chat.open(tmp());
  chat.append("echo", text(1), "2026-09-07", { stream: "e", at: 1, n: 0 });
  chat.fail(chat.take()!.ref);
  chat.append("echo", text(1), "2026-09-07", { stream: "e", at: 1, n: 0 });
  assert.equal(chat.failures, 1);
  chat.append("user", "new", "2026-09-07", { stream: "e", at: 2, n: 0 });
  assert.equal(chat.failures, 0);
});

it("a chat opens once per process; closing frees it", async () => {
  const dir = tmp();
  const chat = Chat.open(dir);
  assert.throws(() => Chat.open(dir), /already open/);
  await chat.close();
  await Chat.open(dir).close();
});

it("a lower pool starts nothing until fewer run, and a reload keeps the settings", () => {
  const chat = Chat.open(tmp());
  for (let i = 0; i < 12; i++) chat.append("echo", text(1), "2026-09-08");
  const jobs = [];
  for (let job = chat.take(); job; job = chat.take()) jobs.push(job);
  assert.equal(jobs.length, 8);
  chat.tune({ pool: 2 });
  for (const job of jobs.slice(0, 6)) chat.done(job.ref, "line");
  assert.equal(chat.inFlight, 2);
  assert.equal(chat.take(), undefined, "started one with 2 running and a pool of 2");
  chat.done(jobs[6].ref, "line");
  assert.ok(chat.take());
  assert.equal(chat.take(), undefined);
  chat.tune({ target: 300 });
  chat.reload();
  assert.deepEqual([chat.pool, chat.target], [2, 300]);
});

it("a target of 256 shapes new tasks' ruler and word hint; 512 stays the limit", () => {
  const chat = Chat.open(tmp());
  chat.append("echo", text(1), "2026-09-09");
  const before = chat.take()!.prompt;
  chat.tune({ target: 256 });
  chat.append("echo", text(2), "2026-09-09");
  const after = chat.take()!.prompt;
  assert.match(before, /at most 512 bytes\n\(about 70 words\), the length of this ruler:\n-{512}\n/);
  assert.match(after, /at most 256 bytes\n\(about 40 words\), the length of this ruler:\n-{256}\n/);
  // A message under 512 bytes is still its own line, word for word.
  chat.append("user", "u".repeat(400), "2026-09-09");
  assert.ok(chat.viewLines().at(-1)!.endsWith(`user: ${"u".repeat(400)}`));
  chat.tune({ target: 4096 });
  assert.equal(chat.target, 512);
  assert.throws(() => chat.tune({ pool: 0 }));
  assert.throws(() => chat.tune({ pool: 2.5 }));
  assert.throws(() => chat.tune({ target: Number.NaN }));
});
