import { describe, expect, it } from "vitest";
import { buildBoard } from "./lanes";
import { filterBoardForDisplay } from "./display-filter";
import { effectiveExpandedIds } from "./expansion";
import { NOW, prMap, thread } from "@/test/fixtures";

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

describe("effectiveExpandedIds", () => {
  it("changes nothing without an active thread or a search", () => {
    const expandedIds = new Set(["root"]);

    // Same set object back: the row callbacks stay memoized between renders.
    expect(effectiveExpandedIds(nested(), { expandedIds })).toBe(expandedIds);
  });

  // Reload straight onto a subagent thread: bb hands us its id to highlight,
  // and a collapsed parent would leave that row off the screen entirely.
  it("opens every ancestor of the active thread", () => {
    const result = effectiveExpandedIds(nested(), {
      expandedIds: new Set(),
      activeThreadId: "grandchild",
    });

    expect([...result].sort()).toEqual(["child", "root"]);
  });

  it("does not open the active thread itself", () => {
    const result = effectiveExpandedIds(nested(), {
      expandedIds: new Set(),
      activeThreadId: "root",
    });

    expect([...result]).toEqual([]);
  });

  it("keeps the user's own toggles alongside the derived ones", () => {
    const expandedIds = new Set(["other"]);

    const result = effectiveExpandedIds(nested(), {
      expandedIds,
      activeThreadId: "child",
    });

    expect([...result].sort()).toEqual(["other", "root"]);
    expect([...expandedIds]).toEqual(["other"]);
  });

  it("ignores an active thread that is not on the board", () => {
    const expandedIds = new Set<string>();

    expect(
      effectiveExpandedIds(nested(), { expandedIds, activeThreadId: "gone" }),
    ).toBe(expandedIds);
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

  it("reaches into settled trees as well as the inbox", () => {
    const quietAt = NOW - 10 * 24 * 3_600_000;
    const board = buildBoard(
      [
        thread("root", { latestAttentionAt: quietAt }),
        thread("child", { parentThreadId: "root", latestAttentionAt: quietAt }),
      ],
      {
        now: NOW,
        prStates: prMap([
          ["root", null],
          ["child", null],
        ]),
      },
    );
    expect(board.settled).toHaveLength(1);

    const result = effectiveExpandedIds(board, {
      expandedIds: new Set(),
      activeThreadId: "child",
    });

    expect([...result]).toEqual(["root"]);
  });
});
