import { describe, expect, it } from "vitest";
import {
  buildBoard,
  laneForThread,
  statusLabelForItem,
  TWO_DAYS_MS,
  type BoardThread,
} from "./lanes";

const NOW = Date.UTC(2026, 7, 8, 12);

function thread(
  id: string,
  overrides: Partial<BoardThread> = {},
): BoardThread {
  return {
    id,
    projectId: "project-1",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    latestAttentionAt: NOW,
    ...overrides,
  };
}

describe("buildBoard", () => {
  it("rolls a child needing input up to its idle parent", () => {
    const board = buildBoard(
      [
        thread("parent"),
        thread("child", {
          parentThreadId: "parent",
          indicator: "waiting-for-input",
        }),
      ],
      { now: NOW },
    );

    expect(board.lanes["needs-you"].map((item) => item.thread.id)).toEqual([
      "parent",
    ]);
  });

  it("rolls an unread settled child up to Needs you", () => {
    const board = buildBoard(
      [
        thread("parent"),
        thread("child", {
          parentThreadId: "parent",
          isUnread: true,
        }),
      ],
      { now: NOW },
    );

    const parent = board.lanes["needs-you"][0]!;
    expect(parent.thread.id).toBe("parent");
    expect(parent.children[0]?.lane).toBe("needs-you");
    expect(statusLabelForItem(parent)).toBe("Subagent needs attention");
    expect(statusLabelForItem(parent.children[0]!)).toBe(
      "Unread subagent result",
    );
  });

  it("rolls running work up through more than one generation", () => {
    const board = buildBoard(
      [
        thread("parent"),
        thread("child", { parentThreadId: "parent" }),
        thread("grandchild", {
          parentThreadId: "child",
          activity: {
            workflows: 1,
            backgroundAgents: 0,
            backgroundCommands: 0,
            planMode: 0,
            goals: 0,
          },
        }),
      ],
      { now: NOW },
    );

    expect(board.lanes.running[0]?.thread.id).toBe("parent");
    expect(statusLabelForItem(board.lanes.running[0]!)).toBe(
      "Subagent running",
    );
    expect(board.lanes.running[0]?.children[0]?.children[0]?.thread.id).toBe(
      "grandchild",
    );
  });

  it("keeps corrupt cyclic ancestry finite and visible", () => {
    const board = buildBoard(
      [
        thread("a", { parentThreadId: "b" }),
        thread("b", { parentThreadId: "a", indicator: "runtime" }),
      ],
      { now: NOW },
    );

    expect(board.lanes.running).toHaveLength(1);
    expect(board.lanes.running[0]?.children).toHaveLength(1);
    expect(board.lanes.running[0]?.children[0]?.children).toHaveLength(0);
  });

  it("promotes a child whose archived parent is absent", () => {
    const board = buildBoard(
      [
        thread("parent", { isArchived: true }),
        thread("child", { parentThreadId: "parent" }),
      ],
      { now: NOW },
    );

    expect(board.lanes.idle.map((item) => item.thread.id)).toEqual(["child"]);
  });

  it("keeps 47-hour idle work and hides 49-hour idle work", () => {
    const board = buildBoard(
      [
        thread("recent", {
          latestAttentionAt: NOW - 47 * 60 * 60 * 1_000,
        }),
        thread("old", {
          latestAttentionAt: NOW - 49 * 60 * 60 * 1_000,
        }),
      ],
      { now: NOW, idleCutoffMs: TWO_DAYS_MS },
    );

    expect(board.lanes.idle.map((item) => item.thread.id)).toEqual(["recent"]);
    expect(board.hiddenIdleCount).toBe(1);
  });

  it("keeps idle work at the exact cutoff boundary", () => {
    const board = buildBoard(
      [thread("boundary", { latestAttentionAt: NOW - TWO_DAYS_MS })],
      { now: NOW },
    );

    expect(board.lanes.idle[0]?.thread.id).toBe("boundary");
  });

  it("never age-filters running or attention work", () => {
    const old = NOW - 30 * 24 * 60 * 60 * 1_000;
    const board = buildBoard(
      [
        thread("attention", {
          indicator: "waiting-for-input",
          latestAttentionAt: old,
        }),
        thread("running", { indicator: "runtime", latestAttentionAt: old }),
      ],
      { now: NOW },
    );

    expect(board.lanes["needs-you"][0]?.thread.id).toBe("attention");
    expect(board.lanes.running[0]?.thread.id).toBe("running");
    expect(board.hiddenIdleCount).toBe(0);
  });

  it("keeps pinned old work, including a pinned descendant", () => {
    const old = NOW - 30 * 24 * 60 * 60 * 1_000;
    const board = buildBoard(
      [
        thread("pinned-root", { latestAttentionAt: old, isPinned: true }),
        thread("parent", { latestAttentionAt: old }),
        thread("pinned-child", {
          parentThreadId: "parent",
          latestAttentionAt: old,
          isPinned: true,
        }),
      ],
      { now: NOW },
    );

    expect(board.lanes.idle.map((item) => item.thread.id)).toEqual([
      "pinned-root",
      "parent",
    ]);
  });

  it("uses recent descendant activity for the idle cutoff", () => {
    const board = buildBoard(
      [
        thread("parent", {
          latestAttentionAt: NOW - 7 * 24 * 60 * 60 * 1_000,
        }),
        thread("child", {
          parentThreadId: "parent",
          latestAttentionAt: NOW - 5 * 60 * 1_000,
        }),
      ],
      { now: NOW },
    );

    expect(board.lanes.idle[0]?.thread.id).toBe("parent");
  });

  it("sorts each lane by the newest descendant activity", () => {
    const board = buildBoard(
      [
        thread("older", { latestAttentionAt: NOW - 60_000 }),
        thread("newer", { latestAttentionAt: NOW - 1_000 }),
      ],
      { now: NOW },
    );

    expect(board.lanes.idle.map((item) => item.thread.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("ignores metadata-only updatedAt changes for recency", () => {
    const metadataUpdated = {
      ...thread("old", {
        latestAttentionAt: NOW - 7 * 24 * 60 * 60 * 1_000,
      }),
      updatedAt: NOW,
    };

    const board = buildBoard([metadataUpdated], { now: NOW });

    expect(board.lanes.idle).toHaveLength(0);
    expect(board.hiddenIdleCount).toBe(1);
  });

  it("filters one project without losing that project's roots", () => {
    const board = buildBoard(
      [
        thread("project-1"),
        thread("project-2", { projectId: "project-2" }),
      ],
      { now: NOW, projectId: "project-2" },
    );

    expect(board.lanes.idle.map((item) => item.thread.id)).toEqual([
      "project-2",
    ]);
  });

  it("projects thousands of mixed parent and child threads", () => {
    const threads: BoardThread[] = [];
    const rootCount = 1_500;
    for (let index = 0; index < rootCount; index += 1) {
      const rootId = `root-${index}`;
      threads.push(thread(rootId, { latestAttentionAt: NOW - index }));
      threads.push(
        thread(`${rootId}-first`, {
          parentThreadId: rootId,
          indicator:
            index % 3 === 0
              ? "waiting-for-input"
              : index % 3 === 1
                ? "runtime"
                : "none",
        }),
        thread(`${rootId}-second`, { parentThreadId: rootId }),
      );
    }

    const board = buildBoard(threads, { now: NOW });
    const projected = [
      ...board.lanes["needs-you"],
      ...board.lanes.running,
      ...board.lanes.idle,
    ];

    expect(projected).toHaveLength(rootCount);
    expect(projected.every((item) => item.children.length === 2)).toBe(true);
    expect(board.lanes["needs-you"]).toHaveLength(500);
    expect(board.lanes.running).toHaveLength(500);
    expect(board.lanes.idle).toHaveLength(500);
  });
});

describe("laneForThread", () => {
  it.each([
    ["a pending interaction", { hasPendingInteraction: true }, "needs-you"],
    ["unread failure", { indicator: "unread-error" }, "needs-you"],
    ["input wait", { indicator: "waiting-for-input" }, "needs-you"],
    ["plan mode", { indicator: "plan-mode" }, "running"],
    ["active goal", { indicator: "goal" }, "running"],
    ["runtime", { indicator: "runtime" }, "running"],
    ["workflow", { indicator: "workflow" }, "running"],
    ["background agent", { indicator: "background-agent" }, "running"],
    ["background command", { indicator: "background-command" }, "running"],
    ["working draft", { indicator: "working-draft" }, "running"],
    [
      "unread settled child",
      { parentThreadId: "parent", isUnread: true },
      "needs-you",
    ],
    [
      "unread child that is still running",
      { parentThreadId: "parent", isUnread: true, indicator: "runtime" },
      "running",
    ],
    [
      "activity without an indicator",
      {
        activity: {
          workflows: 0,
          backgroundAgents: 1,
          backgroundCommands: 0,
          planMode: 0,
          goals: 0,
        },
      },
      "running",
    ],
  ] as const)("classifies %s", (_name, overrides, expected) => {
    expect(laneForThread(thread("classified", overrides))).toBe(expected);
  });

  it("treats an unknown future indicator as idle", () => {
    expect(laneForThread(thread("future", { indicator: "future-state" }))).toBe(
      "idle",
    );
  });

  it("keeps fallback status labels accurate", () => {
    expect(
      statusLabelForItem({
        thread: thread("pending", { hasPendingInteraction: true }),
        lane: "needs-you",
      }),
    ).toBe("Thread needs attention");
    expect(
      statusLabelForItem({
        thread: thread("workflow", {
          indicator: "workflow",
          indicatorLabel: "Workflow running",
        }),
        lane: "running",
      }),
    ).toBe("Workflow running");
  });
});
