import { describe, expect, it } from "vitest";
import { mdToSpeakable } from "../lib/speakable";

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
});
