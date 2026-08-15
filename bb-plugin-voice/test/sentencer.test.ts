import { describe, expect, it } from "vitest";
import { SentenceAssembler } from "../lib/sentencer";

describe("SentenceAssembler", () => {
  it("emits one sentence per chunk and carries split words across deltas", () => {
    const assembler = new SentenceAssembler();

    expect(assembler.push("The first sent")).toEqual([]);
    expect(assembler.push("ence. The second! A third? ")).toEqual([
      { speakable: "The first sentence.", rawStart: 0, rawEnd: 19 },
      { speakable: "The second!", rawStart: 19, rawEnd: 31 },
      { speakable: "A third?", rawStart: 31, rawEnd: 40 },
    ]);
  });

  it("holds punctuation inside a fenced block until a later closed fence", () => {
    const assembler = new SentenceAssembler();

    expect(assembler.push("Before.\n\n```ts\nconst answer = 1.")).toEqual([
      { speakable: "Before.", rawStart: 0, rawEnd: 7 },
    ]);
    expect(assembler.push("\n```\nAfter. ")).toEqual([
      {
        speakable: "code omitted\nAfter.",
        rawStart: 9,
        rawEnd: 43,
      },
    ]);
  });

  it("keeps decimals, versions, and domains in the same sentence", () => {
    const assembler = new SentenceAssembler();

    expect(
      assembler.push(
        "Pi is 3.14. Version 2.12.1 is valid. Visit example.com for docs. Done. ",
      ).map((sentence) => sentence.speakable),
    ).toEqual([
      "Pi is 3.14.",
      "Version 2.12.1 is valid.",
      "Visit example.com for docs.",
      "Done.",
    ]);
  });

  it("holds a punctuation boundary at the end of a delta", () => {
    const assembler = new SentenceAssembler();

    expect(assembler.push("A sentence.")).toEqual([]);
    expect(assembler.push(" ")).toEqual([
      { speakable: "A sentence.", rawStart: 0, rawEnd: 11 },
    ]);
  });

  it("keeps sentence punctuation inside a link label in one chunk", () => {
    const assembler = new SentenceAssembler();

    expect(assembler.push("[Read this. Then continue]")).toEqual([]);
    expect(assembler.push("(url). Next sentence. ").map(
      (sentence) => sentence.speakable,
    )).toEqual([
      "Read this. Then continue.",
      "Next sentence.",
    ]);
  });

  it("replays plain bracket text with normal sentence boundaries", () => {
    const assembler = new SentenceAssembler();

    expect(
      assembler.push("[note] rest. More. ").map((sentence) => sentence.speakable),
    ).toEqual(["[note] rest.", "More."]);
  });

  it("falls back at a held boundary for an unclosed bracket", () => {
    const assembler = new SentenceAssembler();
    const prefix = "[" + "word ".repeat(100);

    const sentences = assembler.push(`${prefix}First. Second. `);

    expect(sentences.map((sentence) => sentence.speakable)).toEqual([
      `${prefix}First.`,
      "Second.",
    ]);
  });

  it("holds inline code, link destinations, and HTML tag attributes", () => {
    const assembler = new SentenceAssembler();

    expect(assembler.push(
      'Use `x.y` and read [the docs](https://example.test/a.b). <span title="x.">Done.</span>',
    )).toEqual([
      {
        speakable: "Use x.y and read the docs.",
        rawStart: 0,
        rawEnd: 56,
      },
    ]);
    expect(assembler.flushTail()).toEqual([
      { speakable: "Done.", rawStart: 56, rawEnd: 86 },
    ]);
  });

  it("does not hard-split live text, but splits a completed tail at raw word boundaries", () => {
    const text = "word ".repeat(150).trimEnd();
    const assembler = new SentenceAssembler();

    expect(assembler.push(text)).toEqual([]);
    const tail = assembler.flushTail();

    expect(tail.length).toBeGreaterThan(1);
    expect(tail[0]!.rawStart).toBe(0);
    expect(tail.at(-1)!.rawEnd).toBe(text.length);
    for (let index = 1; index < tail.length; index += 1) {
      expect(tail[index]!.rawStart).toBe(tail[index - 1]!.rawEnd);
    }
    expect(tail.every((sentence) => sentence.rawEnd - sentence.rawStart <= 500)).toBe(true);
  });

  it("keeps a fenced block whole when hard-splitting a long tail", () => {
    const code = "const answer = 42;\n".repeat(40);
    const text = `${"Opening words ".repeat(45)}\n` +
      "```ts\n" + code + "```\nClosing words";
    const assembler = new SentenceAssembler();

    expect(assembler.push(text)).toEqual([]);
    const tail = assembler.flushTail();

    expect(tail.length).toBeGreaterThan(1);
    expect(tail.every((sentence) => !sentence.speakable.includes("const answer"))).toBe(true);
    expect(tail.filter((sentence) => sentence.speakable.includes("code omitted"))).toHaveLength(1);
    expect(tail.every(
      (sentence) => (sentence.speakable.match(/code omitted/g) ?? []).length <= 1,
    )).toBe(true);
  });

  it("flushes a punctuation-free tail once the message completes", () => {
    const assembler = new SentenceAssembler();

    expect(assembler.push("A final thought")).toEqual([]);
    expect(assembler.flushTail()).toEqual([
      { speakable: "A final thought", rawStart: 0, rawEnd: 15 },
    ]);
    expect(assembler.flushTail()).toEqual([]);
  });
});
