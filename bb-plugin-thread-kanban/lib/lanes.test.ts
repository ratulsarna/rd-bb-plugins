import { describe, expect, it } from "vitest";
import {
  buildBoard,
  canSettle,
  laneForThread,
  selectPrProbeTargets,
  statusLabelForItem,
  TWO_DAYS_MS,
  type BoardThread,
} from "./lanes";
import { DAY, HOUR, NOW, overrideMap, prMap, thread } from "@/test/fixtures";

describe("buildBoard rollups", () => {
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

    expect(board.inbox[0]?.thread.id).toBe("parent");
    expect(board.inbox[0]?.lane).toBe("needs-you");
  });

  it("rolls an unread settled child up as needing attention", () => {
    const board = buildBoard(
      [
        thread("parent"),
        thread("child", { parentThreadId: "parent", isUnread: true }),
      ],
      { now: NOW },
    );

    const parent = board.inbox[0]!;
    expect(parent.lane).toBe("needs-you");
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

    const parent = board.inbox[0]!;
    expect(parent.lane).toBe("running");
    expect(statusLabelForItem(parent)).toBe("Subagent running");
    expect(parent.children[0]?.children[0]?.thread.id).toBe("grandchild");
  });

  it("keeps corrupt cyclic ancestry finite and visible", () => {
    const board = buildBoard(
      [
        thread("a", { parentThreadId: "b" }),
        thread("b", { parentThreadId: "a", indicator: "runtime" }),
      ],
      { now: NOW },
    );

    expect(board.inbox).toHaveLength(1);
    expect(board.inbox[0]?.children).toHaveLength(1);
    expect(board.inbox[0]?.children[0]?.children).toHaveLength(0);
  });

  it("promotes a child whose archived parent is absent", () => {
    const board = buildBoard(
      [
        thread("parent", { isArchived: true }),
        thread("child", { parentThreadId: "parent" }),
      ],
      { now: NOW },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["child"]);
  });
});

describe("buildBoard quiet auto-settle", () => {
  it("keeps 47-hour-quiet work in the inbox and settles 49-hour-quiet work", () => {
    const board = buildBoard(
      [
        thread("recent", { latestAttentionAt: NOW - 47 * HOUR }),
        thread("old", { latestAttentionAt: NOW - 49 * HOUR }),
      ],
      {
        now: NOW,
        idleCutoffMs: TWO_DAYS_MS,
        prStates: prMap([
          ["recent", null],
          ["old", null],
        ]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["recent"]);
    expect(board.settled.map((item) => item.thread.id)).toEqual(["old"]);
    expect(board.settled[0]?.isAuto).toBe(true);
    expect(board.settled[0]?.settledAt).toBe(NOW - 49 * HOUR);
  });

  it("keeps work at the exact cutoff boundary in the inbox", () => {
    const board = buildBoard(
      [thread("boundary", { latestAttentionAt: NOW - TWO_DAYS_MS })],
      { now: NOW, prStates: prMap([["boundary", null]]) },
    );

    expect(board.inbox[0]?.thread.id).toBe("boundary");
    expect(board.settled).toHaveLength(0);
  });

  it("never settles running or attention work, however old", () => {
    const old = NOW - 30 * DAY;
    const board = buildBoard(
      [
        thread("attention", {
          indicator: "waiting-for-input",
          latestAttentionAt: old,
        }),
        thread("running", { indicator: "runtime", latestAttentionAt: old }),
      ],
      {
        now: NOW,
        prStates: prMap([
          ["attention", null],
          ["running", null],
        ]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id).sort()).toEqual([
      "attention",
      "running",
    ]);
    expect(board.settled).toHaveLength(0);
  });

  it("uses recent descendant activity for the quiet clock", () => {
    const board = buildBoard(
      [
        thread("parent", { latestAttentionAt: NOW - 7 * DAY }),
        thread("child", {
          parentThreadId: "parent",
          latestAttentionAt: NOW - 5 * 60 * 1_000,
        }),
      ],
      {
        now: NOW,
        prStates: prMap([
          ["parent", null],
          ["child", null],
        ]),
      },
    );

    expect(board.inbox[0]?.thread.id).toBe("parent");
    expect(board.settled).toHaveLength(0);
  });

  it("ignores metadata-only updatedAt changes for the quiet clock", () => {
    const metadataUpdated = {
      ...thread("old", { latestAttentionAt: NOW - 7 * DAY }),
      updatedAt: NOW,
    };

    const board = buildBoard([metadataUpdated], {
      now: NOW,
      prStates: prMap([["old", null]]),
    });

    expect(board.settled.map((item) => item.thread.id)).toEqual(["old"]);
  });
});

describe("buildBoard pinned", () => {
  it("shelves pinned roots regardless of urgency or age", () => {
    const board = buildBoard(
      [
        thread("pinned-quiet", {
          isPinned: true,
          latestAttentionAt: NOW - 30 * DAY,
        }),
        thread("pinned-urgent", {
          isPinned: true,
          indicator: "waiting-for-input",
        }),
      ],
      {
        now: NOW,
        prStates: prMap([
          ["pinned-quiet", null],
          ["pinned-urgent", null],
        ]),
      },
    );

    expect(board.pinned.map((item) => item.thread.id).sort()).toEqual([
      "pinned-quiet",
      "pinned-urgent",
    ]);
    expect(board.inbox).toHaveLength(0);
    expect(board.settled).toHaveLength(0);
  });

  it("lets a pinned descendant block auto-settle of a quiet parent", () => {
    const old = NOW - 30 * DAY;
    const board = buildBoard(
      [
        thread("parent", { latestAttentionAt: old }),
        thread("pinned-child", {
          parentThreadId: "parent",
          latestAttentionAt: old,
          isPinned: true,
        }),
      ],
      {
        now: NOW,
        prStates: prMap([
          ["parent", null],
          ["pinned-child", null],
        ]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["parent"]);
    expect(board.settled).toHaveLength(0);
  });
});

describe("buildBoard overrides", () => {
  it("settles on a user mark and reports it as manual", () => {
    const markAt = NOW - HOUR;
    const board = buildBoard(
      [thread("done", { latestAttentionAt: NOW - 2 * HOUR })],
      { now: NOW, overrides: overrideMap([["done", "settled", markAt]]) },
    );

    expect(board.settled[0]?.thread.id).toBe("done");
    expect(board.settled[0]?.isAuto).toBe(false);
    expect(board.settled[0]?.settledAt).toBe(markAt);
  });

  it("un-settles a marked thread when new attention arrives", () => {
    const markAt = NOW - 2 * HOUR;
    const board = buildBoard(
      [thread("resurfaced", { latestAttentionAt: NOW - HOUR })],
      {
        now: NOW,
        overrides: overrideMap([["resurfaced", "settled", markAt]]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["resurfaced"]);
    expect(board.settled).toHaveLength(0);
  });

  it("never settles a marked thread that is still working", () => {
    const board = buildBoard(
      [thread("busy", { indicator: "runtime", latestAttentionAt: NOW - DAY })],
      { now: NOW, overrides: overrideMap([["busy", "settled", NOW]]) },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["busy"]);
  });

  it("rejects a settle mark when the tree contains a pinned thread", () => {
    const board = buildBoard(
      [
        thread("parent", { latestAttentionAt: NOW - DAY }),
        thread("pinned-child", {
          parentThreadId: "parent",
          isPinned: true,
          latestAttentionAt: NOW - DAY,
        }),
      ],
      {
        now: NOW,
        overrides: overrideMap([["parent", "settled", NOW]]),
        prStates: prMap([
          ["parent", null],
          ["pinned-child", null],
        ]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["parent"]);
    expect(board.settled).toHaveLength(0);
  });

  it("restarts the quiet clock from a fresh active override", () => {
    const board = buildBoard(
      [thread("kept", { latestAttentionAt: NOW - 30 * DAY })],
      {
        now: NOW,
        overrides: overrideMap([["kept", "active", NOW - HOUR]]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["kept"]);
  });

  it("lets auto-settle resume once an active override goes quiet too", () => {
    const overrideAt = NOW - 3 * DAY;
    const board = buildBoard(
      [thread("kept", { latestAttentionAt: NOW - 30 * DAY })],
      {
        now: NOW,
        overrides: overrideMap([["kept", "active", overrideAt]]),
        prStates: prMap([["kept", null]]),
      },
    );

    expect(board.settled[0]?.thread.id).toBe("kept");
    expect(board.settled[0]?.isAuto).toBe(true);
    expect(board.settled[0]?.settledAt).toBe(overrideAt);
  });
});

describe("buildBoard pull requests", () => {
  it("keeps missing PR state unknown and blocks auto and manual settle", () => {
    const board = buildBoard(
      [thread("unknown", { latestAttentionAt: NOW - 30 * DAY })],
      { now: NOW },
    );

    expect(board.settled).toHaveLength(0);
    expect(board.inbox[0]?.treePr).toBe("unknown");
    expect(canSettle(board.inbox[0]!)).toBe(false);
  });

  it("auto-settles a quiet thread after a known no-PR result", () => {
    const board = buildBoard(
      [thread("known-clear", { latestAttentionAt: NOW - 30 * DAY })],
      { now: NOW, prStates: prMap([["known-clear", null]]) },
    );

    expect(board.settled.map((item) => item.thread.id)).toEqual([
      "known-clear",
    ]);
  });

  it("settles a merged or closed PR immediately, even with recent activity", () => {
    const board = buildBoard(
      [
        thread("merged", { latestAttentionAt: NOW - HOUR }),
        thread("merged-child", {
          parentThreadId: "merged",
          latestAttentionAt: NOW - HOUR,
        }),
        thread("closed", { latestAttentionAt: NOW - HOUR }),
      ],
      {
        now: NOW,
        prStates: prMap([
          ["merged", "merged"],
          ["merged-child", null],
          ["closed", "closed"],
        ]),
      },
    );

    expect(board.settled.map((item) => item.thread.id).sort()).toEqual([
      "closed",
      "merged",
    ]);
    expect(board.settled.every((item) => item.isAuto)).toBe(true);
    expect(board.inbox).toHaveLength(0);
  });

  it("keeps a merged PR in the inbox while a fresh active override holds", () => {
    const board = buildBoard(
      [thread("held", { latestAttentionAt: NOW - HOUR })],
      {
        now: NOW,
        overrides: overrideMap([["held", "active", NOW - HOUR / 2]]),
        prStates: prMap([["held", "merged"]]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["held"]);
  });

  it("never settles a merged PR whose thread is still working", () => {
    const board = buildBoard(
      [thread("busy", { indicator: "runtime" })],
      { now: NOW, prStates: prMap([["busy", "merged"]]) },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["busy"]);
  });

  it("blocks quiet auto-settle while a PR is open or draft", () => {
    const old = NOW - 30 * DAY;
    const board = buildBoard(
      [
        thread("open-pr", { latestAttentionAt: old }),
        thread("draft-pr", { latestAttentionAt: old }),
        thread("no-pr", { latestAttentionAt: old }),
      ],
      {
        now: NOW,
        prStates: prMap([
          ["open-pr", "open"],
          ["draft-pr", "draft"],
          ["no-pr", null],
        ]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id).sort()).toEqual([
      "draft-pr",
      "open-pr",
    ]);
    expect(board.settled.map((item) => item.thread.id)).toEqual(["no-pr"]);
  });

  it("keeps a merged PR with a pinned descendant in the inbox", () => {
    const board = buildBoard(
      [
        thread("parent", { latestAttentionAt: NOW - HOUR }),
        thread("pinned-child", {
          parentThreadId: "parent",
          isPinned: true,
          latestAttentionAt: NOW - HOUR,
        }),
      ],
      {
        now: NOW,
        prStates: prMap([
          ["parent", "merged"],
          ["pinned-child", null],
        ]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["parent"]);
  });

  it.each(["open", "draft"] as const)(
    "blocks auto and manual settle for a %s PR on a descendant",
    (childPr) => {
      const old = NOW - 30 * DAY;
      const board = buildBoard(
        [
          thread("parent", { latestAttentionAt: old }),
          thread("child", {
            parentThreadId: "parent",
            latestAttentionAt: old,
          }),
        ],
        {
          now: NOW,
          prStates: prMap([
            ["parent", null],
            ["child", childPr],
          ]),
        },
      );

      expect(board.settled).toHaveLength(0);
      expect(board.inbox[0]?.treePr).toBe("in-flight");
      expect(canSettle(board.inbox[0]!)).toBe(false);
    },
  );

  it.each([
    ["unknown", undefined],
    ["open", "open"],
    ["draft", "draft"],
  ] as const)(
    "does not immediately settle a merged root with a %s child",
    (_name, childPr) => {
      const states = prMap([["parent", "merged"]]);
      if (childPr) states.set("child", childPr);
      const board = buildBoard(
        [thread("parent"), thread("child", { parentThreadId: "parent" })],
        { now: NOW, prStates: states },
      );

      expect(board.inbox.map((item) => item.thread.id)).toEqual(["parent"]);
      expect(board.settled).toHaveLength(0);
    },
  );

  it("rejects an in-flight settle mark but honors one while PR state is unknown", () => {
    const board = buildBoard(
      [
        thread("blocked"),
        thread("blocked-child", { parentThreadId: "blocked" }),
        thread("unknown"),
      ],
      {
        now: NOW,
        overrides: overrideMap([
          ["blocked", "settled", NOW],
          ["unknown", "settled", NOW],
        ]),
        prStates: prMap([
          ["blocked", null],
          ["blocked-child", "open"],
        ]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual(["blocked"]);
    expect(board.settled.map((item) => item.thread.id)).toEqual(["unknown"]);
  });
});

describe("buildBoard ordering", () => {
  it("orders the inbox by latest activity, counting descendants", () => {
    const board = buildBoard(
      [
        thread("older-but-loud", {
          createdAt: NOW - 5 * DAY,
          latestAttentionAt: NOW,
        }),
        thread("newer-but-quiet", {
          createdAt: NOW - HOUR,
          latestAttentionAt: NOW - DAY,
        }),
        thread("quiet-parent-busy-child", {
          createdAt: NOW - 10 * DAY,
          latestAttentionAt: NOW - 2 * DAY + HOUR,
        }),
        thread("busy-child", {
          parentThreadId: "quiet-parent-busy-child",
          latestAttentionAt: NOW - HOUR,
        }),
      ],
      { now: NOW },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual([
      "older-but-loud",
      "quiet-parent-busy-child",
      "newer-but-quiet",
    ]);
  });

  it("orders settled threads by when they settled, newest first", () => {
    const board = buildBoard(
      [
        thread("settled-early", { latestAttentionAt: NOW - DAY }),
        thread("settled-late", { latestAttentionAt: NOW - DAY }),
      ],
      {
        now: NOW,
        overrides: overrideMap([
          ["settled-early", "settled", NOW - 5 * HOUR],
          ["settled-late", "settled", NOW - HOUR],
        ]),
      },
    );

    expect(board.settled.map((item) => item.thread.id)).toEqual([
      "settled-late",
      "settled-early",
    ]);
  });
});

// Project scoping moved to filterBoardForDisplay — see display-filter.test.ts.
describe("buildBoard pinned order", () => {
  const pins = () => [
    thread("a", { isPinned: true, createdAt: NOW - 3 * DAY }),
    thread("b", { isPinned: true, createdAt: NOW - 2 * DAY }),
    thread("c", { isPinned: true, createdAt: NOW - DAY }),
  ];

  it("uses bb's order rather than the creation sort", () => {
    const board = buildBoard(pins(), {
      now: NOW,
      pinnedOrder: ["b", "c", "a"],
    });

    expect(board.pinned.map((item) => item.thread.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("keeps the newest-first fallback when no order is known", () => {
    const board = buildBoard(pins(), { now: NOW });

    expect(board.pinned.map((item) => item.thread.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  // A thread pinned since the last read isn't in bb's list yet. Sorting it to
  // the bottom would read as the pin having failed.
  it("puts threads the order does not know on top, newest first", () => {
    const board = buildBoard(pins(), { now: NOW, pinnedOrder: ["a"] });

    expect(board.pinned.map((item) => item.thread.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("ignores ids in the order that are not on the board", () => {
    const board = buildBoard(pins(), {
      now: NOW,
      pinnedOrder: ["gone", "c", "b", "a"],
    });

    expect(board.pinned.map((item) => item.thread.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("leaves the inbox and settled sorts alone", () => {
    const quietAt = NOW - 10 * DAY;
    const board = buildBoard(
      [
        thread("pin", { isPinned: true }),
        thread("busy", { latestAttentionAt: NOW }),
        thread("stale", { latestAttentionAt: NOW - HOUR }),
        thread("done", { latestAttentionAt: quietAt }),
      ],
      {
        now: NOW,
        pinnedOrder: ["pin"],
        prStates: prMap([["done", null]]),
      },
    );

    expect(board.inbox.map((item) => item.thread.id)).toEqual([
      "busy",
      "stale",
    ]);
    expect(board.settled.map((item) => item.thread.id)).toEqual(["done"]);
  });
});

describe("buildBoard scale", () => {
  it("projects thousands of mixed parent and child threads", () => {
    const threads: BoardThread[] = [];
    const rootCount = 1_500;
    for (let index = 0; index < rootCount; index += 1) {
      const rootId = `root-${index}`;
      threads.push(
        thread(rootId, {
          createdAt: NOW - index,
          latestAttentionAt: NOW - index,
          isPinned: index % 10 === 0,
        }),
      );
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
    const projected = [...board.pinned, ...board.inbox, ...board.settled];

    expect(projected).toHaveLength(rootCount);
    expect(projected.every((item) => item.children.length === 2)).toBe(true);
    expect(board.pinned).toHaveLength(150);
    expect(board.settled).toHaveLength(0);
  });
});

describe("selectPrProbeTargets", () => {
  it("probes every settle-relevant tree and any otherwise hidden rendered row", () => {
    const board = buildBoard(
      [
        thread("pinned", { isPinned: true }),
        thread("pinned-child", { parentThreadId: "pinned" }),
        thread("running", { indicator: "runtime" }),
        thread("running-child", { parentThreadId: "running" }),
        thread("idle"),
        thread("idle-child", { parentThreadId: "idle" }),
        thread("settled"),
        thread("settled-child", { parentThreadId: "settled" }),
      ],
      {
        now: NOW,
        overrides: overrideMap([["settled", "settled", NOW]]),
      },
    );

    expect(
      [...selectPrProbeTargets(board, new Set(), false)].sort(),
    ).toEqual(
      [
        "idle",
        "idle-child",
        "pinned",
        "running",
        "settled",
        "settled-child",
      ].sort(),
    );

    expect(
      [
        ...selectPrProbeTargets(
          board,
          new Set(["pinned", "running"]),
          false,
        ),
      ].sort(),
    ).toEqual(
      [
        "idle",
        "idle-child",
        "pinned",
        "pinned-child",
        "running",
        "running-child",
        "settled",
        "settled-child",
      ].sort(),
    );
  });
});

describe("canSettle", () => {
  it("only allows settling idle, clear trees without pinned threads", () => {
    const idle = {
      lane: "idle" as const,
      hasPinnedThread: false,
      treePr: "clear" as const,
    };
    expect(canSettle(idle)).toBe(true);
    expect(canSettle({ ...idle, lane: "running" })).toBe(false);
    expect(canSettle({ ...idle, lane: "needs-you" })).toBe(false);
    expect(canSettle({ ...idle, hasPinnedThread: true })).toBe(false);
    expect(canSettle({ ...idle, treePr: "unknown" })).toBe(false);
    expect(canSettle({ ...idle, treePr: "in-flight" })).toBe(false);
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
