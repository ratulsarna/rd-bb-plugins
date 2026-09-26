import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("skill frontmatter", () => {
  it("parses as YAML with the directory name and a description", () => {
    const skillsDirectory = resolve("skills");
    const skillFiles = readdirSync(skillsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(skillsDirectory, entry.name, "SKILL.md"));
    expect(skillFiles.map((file) => basename(join(file, "..")))).toEqual(["pipeline"]);

    for (const skillFile of skillFiles) {
      const contents = readFileSync(skillFile, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
        contents,
      );
      expect(frontmatter, skillFile).not.toBeNull();

      const metadata = parse(frontmatter![1]!) as unknown;
      expect(metadata, skillFile).toBeTypeOf("object");
      expect(metadata, skillFile).not.toBeNull();
      const fields = metadata as Record<string, unknown>;
      expect(fields.name, skillFile).toBe(basename(join(skillFile, "..")));
      expect(fields.description, skillFile).toBeTypeOf("string");
      expect((fields.description as string).trim(), skillFile).not.toBe("");
    }
  });

  it("documents the issue import commands and the card's local scope", () => {
    const skill = readFileSync(join(resolve("skills"), "pipeline", "SKILL.md"), "utf8");
    for (const fragment of [
      "bb pipeline issues",
      "bb pipeline import-issues",
      "--body <text>",
      "--body-file <path>",
      "read-only",
    ]) {
      expect(skill, fragment).toContain(fragment);
    }
  });
});
