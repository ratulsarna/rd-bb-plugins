import assert from "node:assert/strict";
import { test } from "node:test";
import { groupTasks, istDateKey, parseLedger } from "../lib/taskwall.ts";

function ledgerTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    text: "A task",
    dueDate: "2026-08-27",
    status: "open",
    createdAt: "2026-08-20T10:00:00+05:30",
    doneAt: null,
    ...overrides,
  };
}

test("IST date keys change at 18:30 UTC", () => {
  assert.equal(istDateKey(new Date("2026-08-26T18:29:59Z")), "2026-08-26");
  assert.equal(istDateKey(new Date("2026-08-26T18:30:00Z")), "2026-08-27");
});

test("tasks are grouped by the IST day and the seventh day is included", () => {
  const input = [
    ledgerTask({ id: "old", dueDate: "2026-08-26" }),
    ledgerTask({ id: "late", dueTime: null }),
    ledgerTask({ id: "early", dueTime: "08:30" }),
    ledgerTask({ id: "week", dueDate: "2026-09-03" }),
    ledgerTask({ id: "later", dueDate: "2026-09-04" }),
    ledgerTask({ id: "someday", dueDate: null }),
  ];
  const { tasks } = parseLedger(JSON.stringify(input));
  const groups = groupTasks(tasks, new Date("2026-08-27T04:00:00Z"));

  assert.deepEqual(groups.overdue.map((task) => task.id), ["old"]);
  assert.deepEqual(groups.today.map((task) => task.id), ["early", "late"]);
  assert.deepEqual(groups.upcoming.map((task) => task.id), ["week"]);
});

test("done today uses the completion time in IST and falls back to due date", () => {
  const input = [
    ledgerTask({ id: "before-midnight", status: "done", doneAt: "2026-08-26T18:29:59Z" }),
    ledgerTask({ id: "after-midnight", status: "done", doneAt: "2026-08-26T18:30:00Z" }),
    ledgerTask({ id: "legacy", status: "done", doneAt: null }),
  ];
  const { tasks } = parseLedger(JSON.stringify(input));
  const groups = groupTasks(tasks, new Date("2026-08-27T04:00:00Z"));

  assert.deepEqual(groups.doneToday.map((task) => task.id), ["after-midnight", "legacy"]);
});

test("bad rows are skipped without hiding valid tasks", () => {
  const input = [
    ledgerTask(),
    ledgerTask({ id: "bad-date", dueDate: "2026-02-30" }),
    ledgerTask({ id: "bad-time", dueTime: "25:00" }),
    { nope: true },
  ];
  const result = parseLedger(JSON.stringify(input));

  assert.equal(result.tasks.length, 1);
  assert.equal(result.skippedCount, 3);
});
