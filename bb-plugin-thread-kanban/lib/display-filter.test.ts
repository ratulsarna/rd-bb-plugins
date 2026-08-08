import { describe, expect, it } from "vitest";
import { buildBoard, canSettle } from "./lanes";
import { filterBoardForDisplay } from "./display-filter";
import { NOW, prMap, thread } from "@/test/fixtures";

describe("filterBoardForDisplay", () => {
  it("filters one project without losing that project's roots", () => {
    const board = buildBoard(
      [thread("project-1"), thread("project-2", { projectId: "project-2" })],
      { now: NOW },
    );

    const view = filterBoardForDisplay(board, { projectId: "project-2" });

    expect(view.inbox.map((item) => item.thread.id)).toEqual(["project-2"]);
  });

  it("returns the projection untouched when nothing is filtered", () => {
    const board = buildBoard([thread("root")], { now: NOW });

    expect(filterBoardForDisplay(board, { projectId: "", query: "  " })).toBe(
      board,
    );
  });

  // The whole reason display filtering is a second layer: a hidden child still
  // owns the open PR that keeps its root in the Inbox. If search could reach
  // the projection, the root would look settleable and quietly disappear.
  it("keeps a root blocked by an open-PR child the query hides", () => {
    const threads = [
      thread("root", { title: "release prep", latestAttentionAt: NOW - 10 * 24 * 3_600_000 }),
      thread("child", {
        title: "subagent work",
        parentThreadId: "root",
        latestAttentionAt: NOW - 10 * 24 * 3_600_000,
      }),
    ];
    const board = buildBoard(threads, {
      now: NOW,
      prStates: prMap([
        ["root", null],
        ["child", "open"],
      ]),
    });

    const view = filterBoardForDisplay(board, { query: "release" });

    const root = view.inbox[0]!;
    expect(view.inbox.map((item) => item.thread.id)).toEqual(["root"]);
    expect(view.settled).toHaveLength(0);
    expect(root.children).toHaveLength(0);
    expect(root.treePr).toBe("in-flight");
    expect(canSettle(root)).toBe(false);
  });

  it("keeps a non-matching parent that hides a matching child", () => {
    const board = buildBoard(
      [
        thread("root", { title: "unrelated" }),
        thread("child", { title: "needle", parentThreadId: "root" }),
      ],
      { now: NOW },
    );

    const view = filterBoardForDisplay(board, { query: "NEEDLE" });

    expect(view.inbox.map((item) => item.thread.id)).toEqual(["root"]);
    expect(view.inbox[0]!.children.map((item) => item.thread.id)).toEqual([
      "child",
    ]);
  });

  it("prunes settled rows while keeping their settle bookkeeping", () => {
    const quietAt = NOW - 10 * 24 * 3_600_000;
    const board = buildBoard(
      [
        thread("kept", { title: "kept work", latestAttentionAt: quietAt }),
        thread("hidden", { title: "other work", latestAttentionAt: quietAt }),
      ],
      {
        now: NOW,
        prStates: prMap([
          ["kept", null],
          ["hidden", null],
        ]),
      },
    );
    expect(board.settled).toHaveLength(2);

    const view = filterBoardForDisplay(board, { query: "kept" });

    expect(view.settled.map((item) => item.thread.id)).toEqual(["kept"]);
    expect(view.settled[0]!.isAuto).toBe(true);
    expect(view.settled[0]!.settledAt).toBe(quietAt);
  });

  it("drops a whole tree when neither the root nor its children match", () => {
    const board = buildBoard(
      [
        thread("root", { title: "alpha" }),
        thread("child", { title: "beta", parentThreadId: "root" }),
      ],
      { now: NOW },
    );

    expect(filterBoardForDisplay(board, { query: "gamma" }).inbox).toHaveLength(
      0,
    );
  });

  it("matches the fallback title when a thread has no title yet", () => {
    const board = buildBoard(
      [thread("root", { title: null, titleFallback: "Untitled deploy" })],
      { now: NOW },
    );

    expect(
      filterBoardForDisplay(board, { query: "deploy" }).inbox,
    ).toHaveLength(1);
  });
});
