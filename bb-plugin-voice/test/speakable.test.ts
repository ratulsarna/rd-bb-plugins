import { describe, expect, it } from "vitest";
import { mdToSpeakable, truncateSpeakable } from "../lib/speakable";

describe("mdToSpeakable", () => {
  it("keeps prose while removing common Markdown marks", () => {
    expect(
      mdToSpeakable(`
# Result

**Build** is _green_. Read [the report](https://example.com/report).

- First item
- Run \`npm test\`
`),
    ).toBe("Result\nBuild is green. Read the report.\nFirst item\nRun npm test");
  });

  it("replaces fenced code with a short spoken marker", () => {
    expect(
      mdToSpeakable(`Before

\`\`\`ts
const answer = 42;
console.log(answer);
\`\`\`

After`),
    ).toBe("Before\ncode omitted\nAfter");
  });

  it("strips HTML tags without eating comparisons or generic types", () => {
    expect(
      mdToSpeakable(
        "Use x < 10 and y > 2 with Map<string, number>. <strong>Done</strong>.",
      ),
    ).toBe("Use x < 10 and y > 2 with Map<string, number>. Done.");
  });
});

describe("truncateSpeakable", () => {
  it("keeps text at the cap and truncates longer text on a sentence boundary", () => {
    const exact = "x".repeat(8_000);
    expect(truncateSpeakable(exact, 8_000)).toBe(exact);

    const sentence = `${"x".repeat(7_900)}. ${"y".repeat(200)}`;
    const truncated = truncateSpeakable(sentence, 8_000);
    expect(truncated).toBe(`${"x".repeat(7_900)}.`);
    expect(truncated.length).toBeLessThanOrEqual(8_000);
  });
});
