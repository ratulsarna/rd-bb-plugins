import { describe, expect, it } from "vitest";
import { leadPrompt } from "../lib/prompts";
import { makeCard } from "./sdk-fake";

describe("lead prompt", () => {
  it("recognizes bug labels without case sensitivity", () => {
    const prompt = leadPrompt(
      makeCard({ issueUrl: "https://github.com/o/r/issues/1" }),
      { title: "Broken", body: "Details", labels: ["Bug"] },
    );

    expect(prompt).toContain("Kind: bug.");
  });
});
