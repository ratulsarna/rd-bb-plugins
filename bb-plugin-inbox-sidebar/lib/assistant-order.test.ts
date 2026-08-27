import { describe, expect, it } from "vitest";
import { assistantDisplayOrder, orderableIds } from "./assistant-order";

const row = (environmentId: string | null, updatedAt: number) => ({
  environmentId,
  updatedAt,
});

describe("assistantDisplayOrder", () => {
  it("puts the saved order above any amount of activity", () => {
    const rows = [row("busy", 300), row("quiet", 100), row("mid", 200)];
    expect(
      assistantDisplayOrder(rows, ["quiet", "mid", "busy"]).map(
        (r) => r.environmentId,
      ),
    ).toEqual(["quiet", "mid", "busy"]);
  });

  it("appends rows the order does not know, newest activity first", () => {
    const rows = [
      row("new-b", 100),
      row("placed", 50),
      row("new-a", 200),
      row(null, 150),
    ];
    expect(
      assistantDisplayOrder(rows, ["placed"]).map((r) => r.environmentId),
    ).toEqual(["placed", "new-a", null, "new-b"]);
  });

  it("survives a saved order full of stale ids", () => {
    const rows = [row("only", 10)];
    expect(
      assistantDisplayOrder(rows, ["gone-1", "gone-2"]).map(
        (r) => r.environmentId,
      ),
    ).toEqual(["only"]);
  });

  it("falls back to activity when nothing is saved", () => {
    const rows = [row("old", 1), row("fresh", 9), row("mid", 5)];
    expect(
      assistantDisplayOrder(rows, []).map((r) => r.environmentId),
    ).toEqual(["fresh", "mid", "old"]);
  });
});

describe("orderableIds", () => {
  it("writes back only rows with a durable key, in display order", () => {
    const display = [row("a", 3), row(null, 2), row("b", 1)];
    expect(orderableIds(display)).toEqual(["a", "b"]);
  });
});
