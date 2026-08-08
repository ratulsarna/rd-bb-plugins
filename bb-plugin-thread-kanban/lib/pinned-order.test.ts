import { describe, expect, it } from "vitest";
import {
  comparePinnedRoots,
  pinnedDropTarget,
  pinnedMoveActions,
  pinnedMoveTarget,
  pinnedRootIds,
  type PinnedThreadEntry,
} from "./pinned-order";

function entry(
  id: string,
  overrides: Partial<PinnedThreadEntry> = {},
): PinnedThreadEntry {
  return { id, pinnedAt: 100, pinSortKey: null, createdAt: 100, ...overrides };
}

const sorted = (entries: PinnedThreadEntry[]) =>
  [...entries].sort(comparePinnedRoots).map((item) => item.id);

describe("comparePinnedRoots", () => {
  it("orders by sort key when both threads carry one", () => {
    expect(
      sorted([
        entry("b", { pinSortKey: "n" }),
        entry("a", { pinSortKey: "e" }),
        entry("c", { pinSortKey: "u" }),
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  // Codepoint order, not locale: "Z" sorts before "a" the way bb's own
  // comparator reads the key, and a locale compare would flip them.
  it("compares sort keys by codepoint", () => {
    expect(
      sorted([entry("lower", { pinSortKey: "a" }), entry("upper", { pinSortKey: "Z" })]),
    ).toEqual(["upper", "lower"]);
  });

  it("falls back to most recently pinned when a key is missing", () => {
    expect(
      sorted([
        entry("old", { pinnedAt: 1, pinSortKey: "a" }),
        entry("new", { pinnedAt: 2, pinSortKey: null }),
      ]),
    ).toEqual(["new", "old"]);
  });

  it("treats a never-pinned thread as the oldest pin", () => {
    expect(
      sorted([entry("unpinned", { pinnedAt: null }), entry("pinned", { pinnedAt: 1 })]),
    ).toEqual(["pinned", "unpinned"]);
  });

  it("breaks a pinnedAt tie with the newer thread", () => {
    expect(
      sorted([
        entry("older", { pinnedAt: 5, createdAt: 1 }),
        entry("newer", { pinnedAt: 5, createdAt: 2 }),
      ]),
    ).toEqual(["newer", "older"]);
  });

  // Codepoint, not locale: ICU would put "apex" before "Zulu", bb would not.
  it("breaks an id tie by codepoint", () => {
    expect(sorted([entry("apex"), entry("Zulu")])).toEqual(["Zulu", "apex"]);
  });

  it("breaks a full tie with the id, including on equal sort keys", () => {
    expect(
      sorted([
        entry("b", { pinSortKey: "same" }),
        entry("a", { pinSortKey: "same" }),
      ]),
    ).toEqual(["a", "b"]);
  });
});

const ORDER = ["a", "b", "c", "d"];

describe("pinnedMoveTarget", () => {
  it("moves a middle thread up between its two neighbours above", () => {
    expect(pinnedMoveTarget(ORDER, "c", "up")).toEqual({
      previousThreadId: "a",
      nextThreadId: "b",
    });
  });

  it("moves a middle thread down between its two neighbours below", () => {
    expect(pinnedMoveTarget(ORDER, "b", "down")).toEqual({
      previousThreadId: "c",
      nextThreadId: "d",
    });
  });

  it("reports an open top when moving into first place", () => {
    expect(pinnedMoveTarget(ORDER, "b", "up")).toEqual({
      previousThreadId: null,
      nextThreadId: "a",
    });
  });

  it("reports an open bottom when moving into last place", () => {
    expect(pinnedMoveTarget(ORDER, "c", "down")).toEqual({
      previousThreadId: "d",
      nextThreadId: null,
    });
  });

  it("has no move at either edge or for an unknown thread", () => {
    expect(pinnedMoveTarget(ORDER, "a", "up")).toBeNull();
    expect(pinnedMoveTarget(ORDER, "d", "down")).toBeNull();
    expect(pinnedMoveTarget(ORDER, "gone", "up")).toBeNull();
  });
});

describe("pinnedDropTarget", () => {
  it("drops above a row", () => {
    expect(pinnedDropTarget(ORDER, "d", "b", "before")).toEqual({
      previousThreadId: "a",
      nextThreadId: "b",
    });
  });

  it("drops below a row", () => {
    expect(pinnedDropTarget(ORDER, "a", "c", "after")).toEqual({
      previousThreadId: "c",
      nextThreadId: "d",
    });
  });

  // The dragged row leaves its old slot first. Reading neighbours from the
  // unmodified list would name the dragged thread as its own neighbour.
  it("ignores the dragged row's old position", () => {
    expect(pinnedDropTarget(ORDER, "b", "a", "after")).toEqual({
      previousThreadId: "a",
      nextThreadId: "c",
    });
    expect(pinnedDropTarget(ORDER, "b", "c", "before")).toEqual({
      previousThreadId: "a",
      nextThreadId: "c",
    });
  });

  it("has no target for a drop on itself or an unknown row", () => {
    expect(pinnedDropTarget(ORDER, "a", "a", "before")).toBeNull();
    expect(pinnedDropTarget(ORDER, "a", "gone", "before")).toBeNull();
    expect(pinnedDropTarget(ORDER, "gone", "a", "before")).toBeNull();
  });
});

describe("pinnedMoveActions", () => {
  it("passes the computed neighbours straight through to the mover", () => {
    const calls: Array<[string, string | null, string | null]> = [];
    const actions = pinnedMoveActions(ORDER, "c", (...args) =>
      calls.push(args),
    );

    expect(actions.canMoveUp).toBe(true);
    expect(actions.canMoveDown).toBe(true);
    actions.moveUp();
    actions.moveDown();

    expect(calls).toEqual([
      ["c", "a", "b"],
      ["c", "d", null],
    ]);
  });

  it("reports an edge thread as unmovable and does nothing if run", () => {
    const calls: unknown[] = [];
    const actions = pinnedMoveActions(ORDER, "a", (...args) =>
      calls.push(args),
    );

    expect(actions.canMoveUp).toBe(false);
    actions.moveUp();
    expect(calls).toEqual([]);
  });
});

describe("pinnedRootIds", () => {
  const root = (
    id: string,
    overrides: Partial<PinnedThreadEntry & { parentThreadId: string | null }> = {},
  ) => ({ ...entry(id), parentThreadId: null, ...overrides });

  // Both server handlers derive the order this way, including the one reading
  // reorderPinned's response — whose array order bb makes no promise about.
  it("sorts a shuffled list into bb's pinned order", () => {
    expect(
      pinnedRootIds([
        root("c", { pinSortKey: "u" }),
        root("a", { pinSortKey: "e" }),
        root("b", { pinSortKey: "n" }),
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  it("drops unpinned threads and pinned subagents", () => {
    expect(
      pinnedRootIds([
        root("pinned", { pinSortKey: "a" }),
        root("loose", { pinnedAt: null, pinSortKey: "b" }),
        root("child", { pinSortKey: "c", parentThreadId: "pinned" }),
      ]),
    ).toEqual(["pinned"]);
  });
});
