import { describe, expect, it } from "vitest";
import { intakePrompt, leadPrompt } from "../lib/prompts";
import type { ImportedIssue } from "../lib/issue-types";
import type { Card } from "../lib/store";
import { makeCard, makeImportedIssue } from "./sdk-fake";

const sourceIssue = makeImportedIssue({
  url: "https://github.com/o/r/issues/7",
  number: 7,
  title: "Search drops recent filters",
  labels: ["bug", "search"],
  updatedAt: "2026-09-20T10:00:00Z",
  body: "Filters vanish after a reload.",
  comments: [
    {
      author: "octo",
      body: "Happens on the phone too.",
      url: "https://github.com/o/r/issues/7#issuecomment-1",
      createdAt: "2026-09-21T09:00:00Z",
    },
  ],
});

function makeImportedCard(
  overrides: Partial<Card> = {},
  imported: ImportedIssue = sourceIssue,
): Card {
  return makeCard({ ...overrides, importedIssue: imported });
}

describe("lead prompt", () => {
  it("recognizes bug labels without case sensitivity", () => {
    const prompt = leadPrompt(
      makeCard({ issueUrl: "https://github.com/o/r/issues/1" }),
      { title: "Broken", body: "Details", labels: ["Bug"] },
    );

    expect(prompt).toContain("Kind: bug.");
  });

  it("keeps local notes apart from the source issue and forbids source edits", () => {
    const card = makeImportedCard({
      body: "Keep scope to the list view; the timeline page is out.",
      tier: "small",
      issueUrl: sourceIssue.url,
    });
    const prompt = leadPrompt(card, {
      title: sourceIssue.title,
      body: sourceIssue.body,
      labels: ["bug"],
    });

    expect(prompt).toContain("Tier: small.");
    expect(prompt).toContain(sourceIssue.url);
    expect(prompt).not.toContain("Kind:");
    expect(prompt).toContain("Source labels: bug");
    expect(prompt).toContain("fallback");
    expect(prompt).toContain("Keep scope to the list view; the timeline page is out.");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("reassign");
    expect(prompt).toContain("--body-file");
    expect(prompt).toContain(sourceIssue.body);
    expect(prompt).toContain("--- source issue ---");
    expect(prompt.indexOf("source issue comments")).toBeLessThan(
      prompt.indexOf("local notes on the card"),
    );
  });

  it("lets the intake's local classification outrank the source labels", () => {
    const card = makeImportedCard({ body: "Intake classified this as a bug: it crashes on load." });
    const prompt = leadPrompt(card, {
      title: sourceIssue.title,
      body: sourceIssue.body,
      labels: [],
    });

    expect(prompt).not.toContain("Kind: feature");
    expect(prompt).toContain("local notes");
    expect(prompt).toContain("fallback");
  });

  it("reads comments from the card snapshot even when the issue argument is a plain read", () => {
    const prompt = leadPrompt(makeImportedCard(), {
      title: sourceIssue.title,
      body: sourceIssue.body,
      labels: [],
    });

    expect(prompt).toContain("octo");
    expect(prompt).toContain("Happens on the phone too.");
  });

  it("shows the stored source state and stays silent for normal cards", () => {
    const closed = { ...sourceIssue, state: "closed" as const };
    expect(leadPrompt(makeImportedCard({}, closed), {
      title: sourceIssue.title,
      body: sourceIssue.body,
      labels: [],
    })).toContain("(#7, closed");

    const normal = leadPrompt(
      makeCard({ issueUrl: "https://github.com/o/r/issues/1" }),
      { title: "Feature", body: "Details", labels: [] },
    );
    expect(normal).not.toContain("local notes on the card");
    expect(normal).not.toContain("read-only");
  });
});

describe("intake prompt", () => {
  it("still opens a normal card by asking what it is about", () => {
    const prompt = intakePrompt(makeCard({ body: "Buttons feel slow" }), "Example");

    expect(prompt).toContain("what this is about");
    expect(prompt).toContain("Buttons feel slow");
    expect(prompt).not.toContain("Imported issues");
  });

  it("opens an imported card with the real issue without filing another", () => {
    const prompt = intakePrompt(makeImportedCard(), "Example");

    expect(prompt).toContain("Imported issues");
    expect(prompt).toContain("#7");
    expect(prompt).toContain(sourceIssue.url);
    expect(prompt).toContain(sourceIssue.body);
    expect(prompt).toContain("Happens on the phone too.");
    expect(prompt).not.toContain("asking the user what this is about");
    expect(prompt).not.toContain("gh issue create");
    expect(prompt).toContain("--body-file");
  });

  it("keeps imported local notes present and shows a closed source state", () => {
    const open = intakePrompt(
      makeImportedCard({ body: "User only cares about the list view." }),
      "Example",
    );
    expect(open).toContain("User only cares about the list view.");
    expect(open).toContain("(open");

    const closed = intakePrompt(
      makeImportedCard({}, { ...sourceIssue, state: "closed" as const }),
      "Example",
    );
    expect(closed).toContain("(closed");
  });

});
