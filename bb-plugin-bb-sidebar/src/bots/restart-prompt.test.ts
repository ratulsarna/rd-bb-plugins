import { describe, expect, it } from "vitest";
import { restartPrompt } from "./restart-prompt";

const sam = {
  homePath: "/home/ratul/assistants/sam",
  targetingAutomations: [],
};

describe("restartPrompt", () => {
  it("dates Sam's note by IST, not the browser clock", () => {
    // 23:30 UTC on the 13th is already 05:00 on the 14th in IST; the wrong
    // day would point Sam at a note that does not exist yet.
    const prompt = restartPrompt(
      "thr_old",
      sam,
      new Date("2026-09-13T23:30:00Z"),
    );
    expect(prompt).toContain("Notes/Dated/2026-09-14/2026-09-14.md");
    expect(prompt).toContain("Notes/Memory/WeekSummary.md");
  });

  it("gives other assistants no reading, they keep no journal", () => {
    const prompt = restartPrompt("thr_old", {
      ...sam,
      homePath: "/home/ratul/assistants/forge",
    });
    expect(prompt).toBe("Continue from thread thr_old.\n\n");
  });

  it("keeps the repoint note right under the line it refers to", () => {
    const prompt = restartPrompt("thr_old", {
      ...sam,
      targetingAutomations: [{ id: "auto_1", name: "heartbeat" }],
    });
    expect(prompt.indexOf("replaces the one above")).toBeLessThan(
      prompt.indexOf("Read ~/ObsidianVault"),
    );
    expect(prompt).toContain("- heartbeat (auto_1)");
  });
});
