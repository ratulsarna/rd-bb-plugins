import { describe, expect, it } from "vitest";
import { buildBoard } from "./lanes";
import { filterBoardForDisplay } from "./display-filter";
import { ancestorIdsOf, effectiveExpandedIds } from "./expansion";
import { NOW, thread } from "@/test/fixtures";

const nested = () =>
  buildBoard(
    [
      thread("root"),
      thread("child", { parentThreadId: "root" }),
      thread("grandchild", { parentThreadId: "child" }),
      thread("other"),
    ],
    { now: NOW },
  );

describe("ancestorIdsOf", () => {
  // Reload straight onto a subagent thread: bb hands us its id to highlight,
  // and a collapsed parent would leave that row off the screen entirely.
  it("lists every ancestor, outermost first", () => {
    expect(ancestorIdsOf(nested(), "grandchild")).toEqual(["root", "child"]);
  });

  it("gives a root an empty path, not a missing one", () => {
    expect(ancestorIdsOf(nested(), "root")).toEqual([]);
  });

  // Null and [] must stay apart: the caller opens nothing for a root, but
  // keeps waiting for a thread the board has not loaded yet.
  it("returns null for a thread the board does not hold", () => {
    expect(ancestorIdsOf(nested(), "gone")).toBeNull();
  });

  it("reaches into settled trees as well as the inbox", () => {
    const quietAt = NOW - 10 * 24 * 3_600_000;
    const board = buildBoard(
      [
        thread("root", { latestAttentionAt: quietAt }),
        thread("child", { parentThreadId: "root", latestAttentionAt: quietAt }),
      ],
      { now: NOW },
    );
    expect(board.settled).toHaveLength(1);

    expect(ancestorIdsOf(board, "child")).toEqual(["root"]);
  });
});

describe("effectiveExpandedIds", () => {
  it("changes nothing without a search", () => {
    const expandedIds = new Set(["root"]);

    // Same set object back: the row callbacks stay memoized between renders.
    expect(effectiveExpandedIds(nested(), { expandedIds })).toBe(expandedIds);
  });

  // While searching, the view holds only matches and the paths down to them,
  // so opening every remaining parent reveals exactly the hits.
  it("opens the path to a match buried under non-matching parents", () => {
    const view = filterBoardForDisplay(nested(), { query: "grandchild" });

    const result = effectiveExpandedIds(view, {
      expandedIds: new Set(),
      revealNested: true,
    });

    expect([...result].sort()).toEqual(["child", "root"]);
  });

  it("leaves childless matches alone while searching", () => {
    const view = filterBoardForDisplay(nested(), { query: "other" });

    expect(
      [
        ...effectiveExpandedIds(view, {
          expandedIds: new Set(),
          revealNested: true,
        }),
      ],
    ).toEqual([]);
  });

  it("keeps the user's own toggles alongside the revealed ones", () => {
    const expandedIds = new Set(["other"]);
    const view = filterBoardForDisplay(nested(), { query: "grandchild" });

    const result = effectiveExpandedIds(view, {
      expandedIds,
      revealNested: true,
    });

    expect([...result].sort()).toEqual(["child", "other", "root"]);
    expect([...expandedIds]).toEqual(["other"]);
  });
});
