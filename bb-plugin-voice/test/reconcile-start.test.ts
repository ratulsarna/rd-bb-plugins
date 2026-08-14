import { describe, expect, it } from "vitest";
import {
  deriveReconcileStart,
  type ChunkLedgerEntry,
} from "../server";

function entry(
  index: number,
  itemId: string,
  epoch: number,
  state: ChunkLedgerEntry["state"],
  rawEnd: number,
): ChunkLedgerEntry {
  return {
    audio: null,
    audioId: `audio-${index}`,
    epoch,
    index,
    itemId,
    speakable: "sentence",
    span: { rawStart: rawEnd - 5, rawEnd },
    state,
  };
}

describe("ledger-derived reconcile start", () => {
  it("uses coveredThrough for a final item in the live epoch, including every state", () => {
    const ledger = [
      entry(0, "final", 3, "queued", 10),
      entry(1, "final", 3, "synthesizing", 20),
      entry(2, "final", 3, "stashed", 30),
      entry(3, "final", 3, "played", 40),
    ];

    expect(deriveReconcileStart({
      ledger,
      finalItemId: "final",
      liveItemId: "final",
      liveEpoch: 3,
      invalidated: false,
    })).toBe(40);
  });

  it("uses only the final item's playedThrough after interruption", () => {
    const ledger = [
      entry(0, "other", 1, "played", 100),
      entry(1, "final", 2, "played", 12),
      entry(2, "final", 2, "stashed", 24),
    ];

    expect(deriveReconcileStart({
      ledger,
      finalItemId: "final",
      liveItemId: null,
      liveEpoch: 3,
      invalidated: true,
    })).toBe(12);
  });

  it("starts at zero for a final item never seen by the follower", () => {
    expect(deriveReconcileStart({
      ledger: [entry(0, "other", 1, "played", 100)],
      finalItemId: "new-final",
      liveItemId: "other",
      liveEpoch: 1,
      invalidated: false,
    })).toBe(0);
  });

  it("does not let a fully played item bleed into an interrupted final item", () => {
    expect(deriveReconcileStart({
      ledger: [entry(0, "A", 1, "played", 100)],
      finalItemId: "B",
      liveItemId: null,
      liveEpoch: 2,
      invalidated: true,
    })).toBe(0);
  });
});
