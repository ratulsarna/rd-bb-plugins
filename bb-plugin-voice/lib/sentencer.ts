import { mdToSpeakable } from "./speakable";

export interface Sentence {
  speakable: string;
  rawStart: number;
  rawEnd: number;
}

interface MarkdownState {
  fence: { marker: "`" | "~"; length: number } | null;
  inlineCodeLength: number | null;
  linkDestinationDepth: number;
  htmlTag: boolean;
  lineStart: boolean;
  linePrefixLength: number;
}

const TAIL_SPLIT_LENGTH = 500;

function newMarkdownState(): MarkdownState {
  return {
    fence: null,
    inlineCodeLength: null,
    linkDestinationDepth: 0,
    htmlTag: false,
    lineStart: true,
    linePrefixLength: 0,
  };
}

function isFenceLine(line: string): { marker: "`" | "~"; length: number } | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(?:[^\n]*)$/);
  if (!match) return null;
  return {
    marker: match[1]![0] as "`" | "~",
    length: match[1]!.length,
  };
}

function runLength(text: string, start: number, character: string): number {
  let end = start;
  while (text[end] === character) end += 1;
  return end - start;
}

function cloneMarkdownState(state: MarkdownState): MarkdownState {
  return {
    ...state,
    fence: state.fence ? { ...state.fence } : null,
  };
}

/**
 * Turns a raw agent-message stream into one speakable sentence per chunk.
 * The raw buffer is intentional: Markdown is not reversible after stripping,
 * so spans must be measured before mdToSpeakable changes the text.
 */
export class SentenceAssembler {
  private raw = "";
  private emitCursor = 0;
  private scanCursor = 0;
  private state = newMarkdownState();

  push(delta: string): Sentence[] {
    if (!delta) return [];
    this.raw += delta;
    return this.scan();
  }

  flushTail(): Sentence[] {
    const sentences: Sentence[] = [];
    while (this.emitCursor < this.raw.length) {
      const remaining = this.raw.length - this.emitCursor;
      let end = this.raw.length;
      if (remaining > TAIL_SPLIT_LENGTH) {
        const hardEnd = this.emitCursor + TAIL_SPLIT_LENGTH;
        const whitespace = this.raw.lastIndexOf(" ", hardEnd);
        if (whitespace > this.emitCursor) {
          end = whitespace;
        } else {
          const nextWhitespace = this.raw.indexOf(" ", hardEnd);
          end = nextWhitespace > this.emitCursor ? nextWhitespace : hardEnd;
        }
      }

      const sentence = this.makeSentence(this.emitCursor, end);
      this.emitCursor = end;
      if (sentence) sentences.push(sentence);
    }
    this.scanCursor = this.raw.length;
    return sentences;
  }

  /** Used by the pure event reducer to carry Markdown state forward. */
  clone(): SentenceAssembler {
    const clone = new SentenceAssembler();
    clone.raw = this.raw;
    clone.emitCursor = this.emitCursor;
    clone.scanCursor = this.scanCursor;
    clone.state = cloneMarkdownState(this.state);
    return clone;
  }

  private scan(): Sentence[] {
    const sentences: Sentence[] = [];

    while (this.scanCursor < this.raw.length) {
      const index = this.scanCursor;

      if (this.state.fence) {
        if (this.state.lineStart) {
          const lineEnd = this.raw.indexOf("\n", index);
          if (lineEnd < 0) {
            this.scanCursor = index;
            return sentences;
          }
          const closing = isFenceLine(this.raw.slice(index, lineEnd));
          if (
            closing &&
            closing.marker === this.state.fence.marker &&
            closing.length >= this.state.fence.length
          ) {
            this.scanCursor = lineEnd + 1;
            this.state.fence = null;
            this.state.lineStart = true;
            this.state.linePrefixLength = 0;
            continue;
          }
        }
        this.consumeCharacter(this.raw[index]!);
        this.scanCursor += 1;
        continue;
      }

      if (this.state.inlineCodeLength !== null) {
        if (this.raw[index] === "`") {
          const length = runLength(this.raw, index, "`");
          if (length === this.state.inlineCodeLength) {
            this.scanCursor += length;
            this.state.inlineCodeLength = null;
            continue;
          }
          this.scanCursor += length;
          continue;
        }
        this.consumeCharacter(this.raw[index]!);
        this.scanCursor += 1;
        continue;
      }

      if (this.state.linkDestinationDepth > 0) {
        const character = this.raw[index]!;
        if (character === "\\") {
          this.scanCursor += Math.min(2, this.raw.length - index);
          continue;
        }
        if (character === "(") this.state.linkDestinationDepth += 1;
        if (character === ")") this.state.linkDestinationDepth -= 1;
        this.scanCursor += 1;
        continue;
      }

      if (this.state.htmlTag) {
        if (this.raw[index] === ">") this.state.htmlTag = false;
        this.scanCursor += 1;
        continue;
      }

      if (this.state.lineStart) {
        const lineEnd = this.raw.indexOf("\n", index);
        if (lineEnd >= 0) {
          const opening = isFenceLine(this.raw.slice(index, lineEnd));
          if (opening) {
            this.state.fence = opening;
            this.scanCursor = lineEnd + 1;
            this.state.lineStart = true;
            this.state.linePrefixLength = 0;
            continue;
          }
        } else if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(this.raw.slice(index))) {
          // A fence line may be split between deltas. Wait for its newline so
          // punctuation in the fence info cannot be mistaken for prose.
          return sentences;
        }
      }

      const character = this.raw[index]!;

      if (character === "`" && this.raw[index + 1] === undefined) {
        return sentences;
      }

      if (character === "`") {
        const length = runLength(this.raw, index, "`");
        this.state.inlineCodeLength = length;
        this.scanCursor += length;
        continue;
      }

      if (character === "]") {
        if (this.raw[index + 1] === undefined) return sentences;
        if (this.raw[index + 1] === "(") {
          this.state.linkDestinationDepth = 1;
          this.scanCursor += 2;
          continue;
        }
      }

      if (character === "<") {
        if (this.raw[index + 1] === undefined) return sentences;
        const next = this.raw[index + 1]!;
        if (next === "/" || /[A-Za-z!]/.test(next)) {
          this.state.htmlTag = true;
          this.scanCursor += 1;
          continue;
        }
      }

      if (
        character === "\n" &&
        (this.raw[index + 1] === "\n" ||
          (this.raw[index + 1] === "\r" && this.raw[index + 2] === "\n"))
      ) {
        let end = this.raw[index + 1] === "\r" ? index + 3 : index + 2;
        while (this.raw[end] === "\n" || this.raw[end] === "\r") end += 1;
        const sentence = this.makeSentence(this.emitCursor, end);
        this.emitCursor = end;
        if (sentence) sentences.push(sentence);
        this.scanCursor = end;
        this.state.lineStart = true;
        this.state.linePrefixLength = 0;
        continue;
      }

      this.consumeCharacter(character);
      this.scanCursor += 1;
      if (character === "." || character === "!" || character === "?") {
        const sentence = this.makeSentence(this.emitCursor, this.scanCursor);
        this.emitCursor = this.scanCursor;
        if (sentence) sentences.push(sentence);
      }
    }

    return sentences;
  }

  private consumeCharacter(character: string): void {
    if (character === "\n") {
      this.state.lineStart = true;
      this.state.linePrefixLength = 0;
      return;
    }
    if (
      this.state.lineStart &&
      (character === " " || character === "\t") &&
      this.state.linePrefixLength < 3
    ) {
      this.state.linePrefixLength += 1;
      return;
    }
    this.state.lineStart = false;
    this.state.linePrefixLength = 0;
  }

  private makeSentence(rawStart: number, rawEnd: number): Sentence | null {
    const speakable = mdToSpeakable(this.raw.slice(rawStart, rawEnd));
    return speakable
      ? { speakable, rawStart, rawEnd }
      : null;
  }
}
