import { describe, expect, it } from "vitest";
import { restartPrompt } from "./restart-prompt";

const PROJECT = "proj_fleet";
const sam = {
  projectId: PROJECT,
  identity: `${PROJECT}:sam`,
  vaultPath: "/home/me/ObsidianVault",
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

  it("resolves the vault as registered on the target host", () => {
    const prompt = restartPrompt("thr_old", {
      ...sam,
      vaultPath: "/Users/me/Vault/ObsidianVault",
    });
    expect(prompt).toContain(
      "/Users/me/Vault/ObsidianVault/Notes/Dated/",
    );
    expect(prompt).not.toContain("/home/me/ObsidianVault");
  });

  it("gives other assistants no reading, they keep no journal", () => {
    const prompt = restartPrompt("thr_old", {
      ...sam,
      identity: `${PROJECT}:forge`,
    });
    expect(prompt).toBe("Start a fresh root conversation. Use thread thr_old as context when needed.\n\n");
  });

  it("skips the reading when the target host has no vault source", () => {
    const prompt = restartPrompt("thr_old", { ...sam, vaultPath: null });
    expect(prompt).toBe("Start a fresh root conversation. Use thread thr_old as context when needed.\n\n");
  });

  it("names automations without seeding a choice that can become stale", () => {
    const prompt = restartPrompt("thr_old", {
      ...sam,
      targetingAutomations: [{ id: "auto_1", name: "heartbeat" }],
    });
    expect(prompt.indexOf("Automations currently targeting the source")).toBeLessThan(
      prompt.indexOf("Read /home/me/ObsidianVault"),
    );
    expect(prompt).toContain("- heartbeat (auto_1)");
  });
});
