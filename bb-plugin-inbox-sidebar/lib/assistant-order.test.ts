import { describe, expect, it } from "vitest";
import { assistantDisplayOrder, projectAssistantReorder } from "./assistant-order";

const row = (identity: string | null, updatedAt: number) => ({
  identity,
  updatedAt,
});

describe("assistantDisplayOrder", () => {
  it("puts the saved order above any amount of activity", () => {
    const rows = [row("busy", 300), row("quiet", 100), row("mid", 200)];
    expect(
      assistantDisplayOrder(rows, ["quiet", "mid", "busy"]).map(
        (r) => r.identity,
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
      assistantDisplayOrder(rows, ["placed"]).map((r) => r.identity),
    ).toEqual(["placed", "new-a", null, "new-b"]);
  });

  it("survives a saved order full of stale ids", () => {
    const rows = [row("only", 10)];
    expect(
      assistantDisplayOrder(rows, ["gone-1", "gone-2"]).map(
        (r) => r.identity,
      ),
    ).toEqual(["only"]);
  });

  it("falls back to activity when nothing is saved", () => {
    const rows = [row("old", 1), row("fresh", 9), row("mid", 5)];
    expect(
      assistantDisplayOrder(rows, []).map((r) => r.identity),
    ).toEqual(["fresh", "mid", "old"]);
  });
});

it("refuses unknown and unresolved drag identities and treats a same-group move as a noop", () => {
  const rows = [{ id: "sam-server", identity: "fleet:sam" }, { id: "sam-mac", identity: "fleet:sam" }, { id: "pending", identity: null }];
  expect(projectAssistantReorder(rows, "unknown", ["sam-server", "sam-mac", "pending"])).toBeNull();
  expect(projectAssistantReorder(rows, "sam-mac", ["sam-mac", "sam-server", "pending"])).toBeNull();
  expect(projectAssistantReorder(rows, "sam-mac", ["sam-server", "pending", "sam-mac"])).toBeNull();
  expect(projectAssistantReorder(rows, "pending", ["pending", "sam-server", "sam-mac"])).toBeNull();
});


it("uses the dragged instance's direction when unsaved conversation groups are interleaved", () => {
  const rows = [{ id: "sam-server", identity: "sam" }, { id: "forge-server", identity: "forge" }, { id: "sam-mac", identity: "sam" }, { id: "forge-mac", identity: "forge" }];
  expect(projectAssistantReorder(rows, "sam-mac", ["sam-server", "sam-mac", "forge-server", "forge-mac"])).toBeNull();
  expect(projectAssistantReorder(rows, "sam-mac", ["sam-server", "forge-server", "forge-mac", "sam-mac"])).toEqual(["forge", "sam"]);
});
