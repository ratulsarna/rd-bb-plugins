import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_GUIDELINES_BYTES, readGuidelines } from "../lib/guidelines";
import { validGuidelinesFile } from "../lib/settings";

const shipped = new URL("../workflows/guidelines/README.md", import.meta.url);
const notes = [
  "# Mine", "", "## Facts", "facts", "", "## Taste", "", "- one", "", "### sub", "- two", "", "````md", "```js", "## Inner fence", "```", "````", "```", "~~~", "## Tilde inside backticks", "```", "- three", "```const value = 1;```", "- four", "", "## Style", "style", "", "# Project notes", "notes", "",
].join("\n");

describe("guidelines", () => {
  it("serves Pipeline's own document when nothing is set, whatever the section says", async () => {
    const own = await readFile(shipped, "utf8");
    expect((await readGuidelines({})).content).toBe(own);
    expect((await readGuidelines({ guidelinesFile: " ", guidelinesSection: "Taste" })).content).toBe(own);
  });

  it("cuts exactly the named section from a user file under ~, keeping its heading, sub-headings, and nested or mixed fenced examples", async () => {
    const home = await mkdtemp(join(tmpdir(), "guidelines-"));
    await writeFile(join(home, "CLAUDE.md"), notes);
    const result = await readGuidelines({ guidelinesFile: "~/CLAUDE.md", guidelinesSection: "Taste" }, home);
    expect(result.source).toBe(join(home, "CLAUDE.md"));
    expect(result.content).toBe("## Taste\n\n- one\n\n### sub\n- two\n\n````md\n```js\n## Inner fence\n```\n````\n```\n~~~\n## Tilde inside backticks\n```\n- three\n```const value = 1;```\n- four\n");
    expect((await readGuidelines({ guidelinesFile: join(home, "CLAUDE.md") }, "/nowhere")).content).toBe(`${notes.trim()}\n`);
    expect((await readGuidelines({ guidelinesFile: "~/CLAUDE.md", guidelinesSection: "## Style" }, home)).content).toBe("## Style\n\nstyle\n");
  });

  it("refuses a missing file, a missing or empty section, and anything but a small .md file at an absolute or ~/ path", async () => {
    const home = await mkdtemp(join(tmpdir(), "guidelines-"));
    await writeFile(join(home, "CLAUDE.md"), `${notes}## Empty\n\n`);
    await writeFile(join(home, "key.md"), "x".repeat(MAX_GUIDELINES_BYTES + 1));
    await mkdir(join(home, "dir.md"));
    await expect(readGuidelines({ guidelinesFile: "~/key.md" }, home)).rejects.toThrow("larger than");
    await expect(readGuidelines({ guidelinesFile: "~/dir.md" }, home)).rejects.toThrow("not a regular file");
    await expect(readGuidelines({ guidelinesFile: "~/.ssh/id_ed25519" }, home)).rejects.toThrow("end in .md");
    await expect(readGuidelines({ guidelinesFile: "~/missing.md" }, home)).rejects.toThrow("~/missing.md is unreadable on the BB server");
    await expect(readGuidelines({ guidelinesFile: "~/CLAUDE.md", guidelinesSection: "Tone" }, home)).rejects.toThrow(`no '## Tone' section in ${join(home, "CLAUDE.md")}`);
    await expect(readGuidelines({ guidelinesFile: "~/CLAUDE.md", guidelinesSection: "Empty" }, home)).rejects.toThrow("guidelines are empty");
    await expect(readGuidelines({ guidelinesFile: "notes/CLAUDE.md" }, home)).rejects.toThrow("absolute path");
    expect(["", "/a.md", "~/a.md"].map(validGuidelinesFile)).toEqual([true, true, true]);
    expect(["a.md", "./a.md", "~a.md", "/a", "~/a", "/dev/zero"].map(validGuidelinesFile)).toEqual([false, false, false, false, false, false]);
  });
});
