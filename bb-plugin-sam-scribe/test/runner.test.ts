import assert from "node:assert/strict";
import { test } from "node:test";
import { ScribeRunner } from "../runner.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { error() {} };

function harness(options: { quietMs?: number; runMs?: number; fail?: (ids: string[] | null) => boolean } = {}) {
  const calls: Array<string[] | null> = [];
  let active = 0;
  let overlap = 0;
  const runner = new ScribeRunner({
    quietMs: () => options.quietMs ?? 20,
    log: silent,
    run: async (ids) => {
      calls.push(ids);
      active += 1;
      overlap = Math.max(overlap, active);
      await wait(options.runMs ?? 15);
      active -= 1;
      if (options.fail?.(ids)) throw new Error("boom");
    },
  });
  return { runner, calls, overlap: () => overlap };
}

test("idles inside the quiet window collapse into one run after the last one", async () => {
  const h = harness();
  h.runner.touch("a");
  await wait(10);
  h.runner.touch("a");
  await wait(15);
  assert.deepEqual(h.calls, [], "the second idle restarted the wait");
  await wait(40);
  assert.deepEqual(h.calls, [["a"]]);
});

test("waking up before the window ends cancels the read", async () => {
  const h = harness();
  h.runner.touch("a");
  h.runner.cancel("a");
  await wait(50);
  assert.deepEqual(h.calls, []);
  assert.equal(h.runner.waiting, 0);
});

test("threads are read one at a time, never together", async () => {
  const h = harness();
  h.runner.touch("a");
  h.runner.touch("b");
  await wait(120);
  assert.deepEqual(h.calls, [["a"], ["b"]]);
  assert.equal(h.overlap(), 1);
});

test("a failing run does not block the next", async () => {
  const h = harness({ fail: (ids) => ids?.[0] === "a" });
  h.runner.touch("a");
  h.runner.touch("b");
  await wait(120);
  assert.deepEqual(h.calls, [["a"], ["b"]]);
});

test("sweeps asked for while one is waiting collapse into one", async () => {
  const h = harness({ quietMs: 1, runMs: 60 });
  h.runner.touch("a");
  await wait(10); // "a" is running
  h.runner.sweep();
  h.runner.sweep();
  await wait(150);
  assert.deepEqual(h.calls, [["a"], null]);
});

test("a sweep asked for while one is running still runs afterwards", async () => {
  const h = harness({ runMs: 40 });
  h.runner.sweep();
  await wait(10);
  h.runner.sweep();
  await wait(120);
  assert.deepEqual(h.calls, [null, null]);
});

test("a thread queued behind a running sweep is dropped when it wakes up", async () => {
  const h = harness({ runMs: 80 });
  h.runner.sweep();
  h.runner.touch("a");
  await wait(40); // sweep still running, "a" has left its timer and sits in the queue
  assert.equal(h.runner.waiting, 1);
  h.runner.cancel("a");
  await wait(120);
  assert.deepEqual(h.calls, [null]);
});

test("dispose drops waiting threads", async () => {
  const h = harness();
  h.runner.touch("a");
  h.runner.dispose();
  await wait(50);
  assert.deepEqual(h.calls, []);
});
