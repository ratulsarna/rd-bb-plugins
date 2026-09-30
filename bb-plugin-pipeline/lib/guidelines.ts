import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { validGuidelinesFile } from "./settings";

export interface GuidelinesSettings {
  guidelinesFile?: string;
  guidelinesSection?: string;
}

function expandHome(path: string, home: string): string {
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

// Lines under `## <heading>` up to the next `#` or `##` heading, the heading line included so
// the reader sees what it was given. Headings are plain and unindented; that is the documented
// limit, not a general Markdown parser. Headings inside fenced code are examples, not structure,
// and a fence closes only on its own character at its own length or longer, as in CommonMark.
// The heading may be typed with or without its `##`.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function section(content: string, requested: string, source: string): string {
  const heading = requested.replace(/^#+\s*/, "");
  const lines = content.split("\n");
  let fence: { mark: string; length: number } | null = null;
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marks = FENCE.exec(line)?.[1];
    if (fence === null) {
      // A backtick run followed by more backticks is inline code, not a fence (CommonMark).
      const opens = marks !== undefined && !(marks[0] === "`" && line.slice(line.indexOf(marks) + marks.length).includes("`"));
      if (opens) { fence = { mark: marks![0]!, length: marks!.length }; continue; }
    } else {
      if (marks !== undefined && marks[0] === fence.mark && marks.length >= fence.length && line.trim() === marks) fence = null;
      continue;
    }
    if (start === -1) {
      if (line.trimEnd() === `## ${heading}`) start = index;
    } else if (/^##? /.test(line)) {
      end = index;
      break;
    }
  }
  if (start === -1) throw new Error(`no '## ${heading}' section in ${source}`);
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (body === "") throw new Error(`guidelines are empty: '## ${heading}' in ${source}`);
  return `${lines[start]!}\n\n${body}`;
}

// Guidelines are prose; a file past this is not the file the setting meant.
export const MAX_GUIDELINES_BYTES = 256 * 1024;

async function readUserFile(file: string, path: string): Promise<string> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`guidelines file ${file} is unreadable on the BB server`);
  }
  if (!info.isFile()) throw new Error(`guidelines file ${file} is not a regular file`);
  if (info.size > MAX_GUIDELINES_BYTES) throw new Error(`guidelines file ${file} is larger than ${MAX_GUIDELINES_BYTES} bytes`);
  return readFile(path, "utf8");
}

export async function readGuidelines(settings: GuidelinesSettings, home = homedir()): Promise<{ source: string; content: string }> {
  const file = settings.guidelinesFile?.trim() ?? "";
  // Pipeline's own document is served whole; a section left over from an earlier file must not cut it.
  const heading = file === "" ? "" : settings.guidelinesSection?.trim() ?? "";
  if (!validGuidelinesFile(file)) throw new Error(`guidelines file must be an absolute path or start with ~/, and end in .md: ${file}`);
  let content: string;
  let shown: string;
  if (file === "") {
    shown = "Pipeline's guidelines";
    try {
      // Both lib/guidelines.ts and the bundled dist/server.js sit one level below the plugin root.
      content = await readFile(new URL("../workflows/guidelines/README.md", import.meta.url), "utf8");
    } catch {
      throw new Error("Pipeline's guidelines document is unavailable; check the plugin installation");
    }
  } else {
    shown = expandHome(file, home);
    content = await readUserFile(file, shown);
  }
  const text = (heading === "" ? content : section(content, heading, shown)).trim();
  if (text === "") throw new Error(`guidelines are empty: ${shown}`);
  return { source: shown, content: `${text}\n` };
}
