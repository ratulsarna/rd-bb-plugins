import { describe, expect, it } from "vitest";
import {
  findTurnAnswer,
  findVoiceRequestId,
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
        item: { type: "agentMessage", id: "old", text: "Old answer" },
      }),
      row(22, "turn/input/accepted", turnScope("voice-turn"), {
        clientRequestId: "voice-request",
      }),
      row(23, "item/completed", turnScope("voice-turn"), {
        item: { type: "agentMessage", id: "draft", text: "Draft answer" },
      }),
      row(24, "item/completed", turnScope("voice-turn"), {
        item: { type: "agentMessage", id: "blank", text: "   " },
      }),
      row(25, "item/completed", turnScope("voice-turn"), {
        item: { type: "agentMessage", id: "final", text: "Final answer" },
      }),
    ];

    expect(findTurnAnswer(rows, "voice-request")).toEqual({
      turnId: "voice-turn",
      itemId: "final",
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
            item: { type: "agentMessage", id: "partial", text: "Partial" },
          }),
        ],
        "voice-request",
      ),
      ).toEqual({ turnId: "voice-turn", itemId: null, text: null });
  });

  it("accepts only non-empty root agent messages", () => {
    expect(
      findTurnAnswer(
        [
          row(1, "turn/input/accepted", turnScope("voice-turn"), {
            clientRequestId: "voice-request",
          }),
          row(2, "item/completed", turnScope("voice-turn"), {
            item: {
              type: "agentMessage",
              id: "nested",
              text: "Nested tool answer.",
              parentToolCallId: "tool-1",
            },
          }),
          row(3, "item/completed", turnScope("voice-turn"), {
            item: {
              type: "agentMessage",
              id: "root",
              text: "  Root answer.  ",
              parentToolCallId: null,
            },
          }),
        ],
        "voice-request",
      ),
    ).toEqual({
      turnId: "voice-turn",
      itemId: "root",
      text: "  Root answer.  ",
    });
  });
});
