import { describe, expect, it } from "vitest";
import {
  initialStreamState,
  processEvents,
  type StreamState,
} from "../lib/stream-follower";
import type { VoiceEventRow } from "../lib/correlation";

const turn = (turnId: string) => ({ kind: "turn", turnId }) as const;
const thread = { kind: "thread" } as const;

function row(seq: number, type: string, scope: VoiceEventRow["scope"], data: unknown): VoiceEventRow {
  return { seq, type, scope, data };
}

describe("stream follower", () => {
  it("filters nested tool-owned assistant deltas and learns the requested turn", () => {
    const state = initialStreamState("0", "request-1");
    const result = processEvents(state, [
      row(1, "turn/input/accepted", turn("other"), { clientRequestId: "other" }),
      row(2, "turn/input/accepted", turn("voice"), { clientRequestId: "request-1" }),
      row(3, "item/agentMessage/delta", turn("voice"), {
        itemId: "nested",
        delta: "Do not say this.",
        parentToolCallId: "tool-1",
      }),
      row(4, "item/agentMessage/delta", turn("voice"), {
        itemId: "root",
        delta: "Say this.",
      }),
      row(5, "item/agentMessage/delta", thread, {
        itemId: "unrelated",
        delta: "Ignore this.",
      }),
    ]);

    expect(result.state.turnId).toBe("voice");
    expect(result.live?.sentences).toEqual([
      { speakable: "Say this.", rawStart: 0, rawEnd: 9 },
    ]);
    expect(result.state.emittedChars).toBe("Say this.".length);
  });

  it("bumps the epoch for every new root and returns only the final live batch", () => {
    const state: StreamState = {
      ...initialStreamState("0", "request-1", "voice"),
    };
    const result = processEvents(state, [
      row(1, "item/started", turn("voice"), {
        item: { type: "agentMessage", id: "first", text: "" },
      }),
      row(2, "item/agentMessage/delta", turn("voice"), {
        itemId: "first",
        delta: "First answer.",
      }),
      row(3, "item/started", turn("voice"), {
        item: { type: "commandExecution", id: "tool-1", command: "ls" },
      }),
      row(4, "item/started", turn("voice"), {
        item: { type: "agentMessage", id: "second", text: "" },
      }),
      row(5, "item/agentMessage/delta", turn("voice"), {
        itemId: "second",
        delta: "Second answer.",
      }),
    ]);

    expect(result.state.epoch).toBe(3);
    expect(result.state.speakingItemId).toBe("second");
    expect(result.state.suppressed).toBe(false);
    expect(result.invalidatePriorAudio).toBe(true);
    expect(result.live).toEqual({
      epoch: 3,
      itemId: "second",
      sentences: [{ speakable: "Second answer.", rawStart: 0, rawEnd: 14 }],
    });
  });

  it("marks suppression when a non-assistant root takes over", () => {
    const state = initialStreamState("0", null, "voice");
    const result = processEvents(state, [
      row(1, "item/agentMessage/delta", turn("voice"), {
        itemId: "answer",
        delta: "Answer.",
      }),
      row(2, "item/started", turn("voice"), {
        item: { type: "userMessage", id: "follow-up", parentToolCallId: null },
      }),
    ]);

    expect(result.state.speakingItemId).toBeNull();
    expect(result.state.suppressed).toBe(true);
    expect(result.state.invalidatedItemIds).toEqual(["answer"]);
    expect(result.live).toBeNull();
  });

  it("advances the cursor once and ignores an overlapping page", () => {
    const first = processEvents(initialStreamState("0", null, "voice"), [
      row(1, "item/agentMessage/delta", turn("voice"), {
        itemId: "answer",
        delta: "One.",
      }),
    ]);
    const second = processEvents(first.state, [
      row(1, "item/agentMessage/delta", turn("voice"), {
        itemId: "answer",
        delta: "One.",
      }),
    ]);

    expect(first.live?.sentences).toHaveLength(1);
    expect(second.live).toBeNull();
    expect(second.state.cursorSeq).toBe("1");
    expect(second.state.emittedChars).toBe(4);
  });

  it("recognizes turn completion only inside the stored turn", () => {
    const result = processEvents(initialStreamState("0", null, "voice"), [
      row(1, "turn/completed", turn("other"), { status: "completed" }),
      row(2, "turn/completed", turn("voice"), { status: "completed" }),
    ]);

    expect(result.turnCompleted).toBe(true);
  });
});
