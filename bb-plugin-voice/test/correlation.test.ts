import { describe, expect, it } from "vitest";
import {
  findTurnAnswer,
  findVoiceRequestId,
  loadEventsAfter,
  type VoiceEventRow,
} from "../lib/correlation";

const threadScope = { kind: "thread" } as const;
const turnScope = (turnId: string) => ({ kind: "turn", turnId }) as const;

function row(
  seq: number,
  type: string,
  scope: VoiceEventRow["scope"],
  data: unknown,
): VoiceEventRow {
  return { seq, type, scope, data };
}

describe("turn correlation", () => {
  it("selects the matching request, not a competing typed request", () => {
    const rows = [
      row(11, "client/turn/requested", threadScope, {
        requestId: "typed",
        initiator: "user",
        input: [{ type: "text", text: "different text" }],
      }),
      row(12, "client/turn/requested", threadScope, {
        requestId: "voice",
        initiator: "user",
        input: [{ type: "text", text: "voice text" }],
      }),
    ];

    expect(findVoiceRequestId(rows, "voice text")).toBe("voice");
  });

  it("follows request acceptance into its turn and takes the last completed answer", () => {
    const rows = [
      row(20, "turn/input/accepted", turnScope("unrelated"), {
        clientRequestId: "older",
      }),
      row(21, "item/completed", turnScope("unrelated"), {
        item: { type: "agentMessage", text: "Old answer" },
      }),
      row(22, "turn/input/accepted", turnScope("voice-turn"), {
        clientRequestId: "voice-request",
      }),
      row(23, "item/completed", turnScope("voice-turn"), {
        item: { type: "agentMessage", text: "Draft answer" },
      }),
      row(24, "item/completed", turnScope("voice-turn"), {
        item: { type: "agentMessage", text: "   " },
      }),
      row(25, "item/completed", turnScope("voice-turn"), {
        item: { type: "agentMessage", text: "Final answer" },
      }),
    ];

    expect(findTurnAnswer(rows, "voice-request")).toEqual({
      turnId: "voice-turn",
      text: "Final answer",
    });
  });

  it("returns no text when the accepted turn has no completed answer", () => {
    expect(
      findTurnAnswer(
        [
          row(30, "turn/input/accepted", turnScope("voice-turn"), {
            clientRequestId: "voice-request",
          }),
          row(31, "item/started", turnScope("voice-turn"), {
            item: { type: "agentMessage", text: "Partial" },
          }),
        ],
        "voice-request",
      ),
    ).toEqual({ turnId: "voice-turn", text: null });
  });

  it("loads every event page before correlating a long turn", async () => {
    const events = Array.from({ length: 101 }, (_, index) =>
      row(index + 1, "item/completed", turnScope("voice-turn"), {
        item: { type: "commandExecution" },
      }),
    );
    events.push(
      row(102, "item/completed", turnScope("voice-turn"), {
        item: { type: "agentMessage", text: "Answer after page one" },
      }),
    );
    const calls: string[] = [];
    const loaded = await loadEventsAfter("0", async (afterSeq) => {
      calls.push(afterSeq);
      return events
        .filter((event) => event.seq > Number(afterSeq))
        .slice(0, 100);
    });

    expect(calls).toEqual(["0", "100"]);
    expect(loaded).toHaveLength(102);
  });
});
