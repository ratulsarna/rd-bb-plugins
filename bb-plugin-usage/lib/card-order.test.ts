import { describe, expect, it } from "vitest";
import { cardKey, moveCard, orderCards } from "./card-order";

const codex = { id: "codex" as const };
const zai = { id: "zai" as const };
const claude = (accountId: string) => ({ id: "claudeCode" as const, accountId });
const keys = (cards: Parameters<typeof cardKey>[0][]) => cards.map(cardKey);

describe("card order", () => {
  it("keeps the default order until something is saved", () => {
    expect(keys(orderCards([codex, zai, claude("a")], []))).toEqual(["codex", "zai", "claudeCode:a"]);
  });

  it("puts a new account after the saved ones and skips a saved account that is gone", () => {
    const saved = ["claudeCode:gone", "claudeCode:b", "zai", "codex"];
    expect(keys(orderCards([codex, zai, claude("new"), claude("b")], saved)))
      .toEqual(["claudeCode:b", "zai", "codex", "claudeCode:new"]);
  });

  it("moves a card up or down to where it was dropped, and ignores a drop it can't place", () => {
    const shown = ["codex", "zai", "claudeCode:a", "claudeCode:b"];
    expect(moveCard(shown, "codex", "claudeCode:a")).toEqual(["zai", "claudeCode:a", "codex", "claudeCode:b"]);
    expect(moveCard(shown, "claudeCode:b", "zai")).toEqual(["codex", "claudeCode:b", "zai", "claudeCode:a"]);
    expect(moveCard(shown, "codex", "claudeCode:gone")).toEqual(shown);
  });
});
