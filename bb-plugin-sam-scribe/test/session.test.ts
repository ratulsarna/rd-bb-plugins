import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_CONTEXT_MARKER, istDay, sessionContext } from "../session.ts";

test("istDay rolls over at Indian midnight, not UTC", () => {
  assert.equal(istDay(new Date("2026-09-13T18:29:00Z")), "2026-09-13");
  assert.equal(istDay(new Date("2026-09-13T18:30:00Z")), "2026-09-14");
});

test("session context starts with the marker and carries both files", () => {
  const text = sessionContext({
    day: "2026-09-14",
    notePath: "Notes/Dated/2026-09-14/2026-09-14.md",
    note: "- 09:00 [decision] Ratul chose X.\n",
    weekPath: "Notes/Memory/WeekSummary.md",
    week: "### Week Summary\n- something happened\n",
  });
  assert.ok(text.startsWith(SESSION_CONTEXT_MARKER + "\n"));
  assert.match(text, /Today is 2026-09-14/);
  assert.match(text, /Ratul chose X/);
  assert.match(text, /something happened/);
  assert.match(text, /HalfYearSummary\.md/);
});

test("an empty note says so instead of vanishing", () => {
  const text = sessionContext({ day: "2026-09-14", notePath: "n", note: "  \n", weekPath: "w", week: "" });
  assert.match(text, /\(empty so far\)/);
  assert.match(text, /\(not built yet\)/);
});
