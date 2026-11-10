// The Claude Code SessionStart hook that hands a memory-on assistant its memory: a script in its home
// and the entry in the home's .claude/settings.json that runs it. Homes sync between machines, so
// writing them on the main chat's machine is enough.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Points the main chat at a fresh copy of its memory on startup, clear and compact; silent for every
 * other session. Stdout becomes context the agent sees before its next step.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# Written by the Assistants plugin at \`bb assistants memory on\`; \`memory off\` removes it.
# Read Claude's input before any exit, so its writer never meets a closed pipe.
input=$(cat)
[ -n "$BB_THREAD_ID" ] || exit 0
# A resumed session still holds its memory in context.
printf '%s' "$input" | grep -q '"source" *: *"resume"' && exit 0
home="\${CLAUDE_PROJECT_DIR:-$PWD}"
dir="$home/nosync"
file="$dir/bb-memory-$BB_THREAD_ID.md"
if ! out=$("\${BB_CLI:-bb}" assistants memory view --home "$home" 2>/dev/null); then
  # Only a chat this hook has given memory before is known to need it; any other stays undisturbed.
  [ -f "$file" ] || exit 0
  echo "Your memory could not be loaded (bb assistants memory view failed). $file is from an earlier session and may be stale. Tell the user before other work, and use \\\`bb assistants recall\\\` for anything from before this session."
  exit 0
fi
# Not a memory-on assistant's main chat in this home.
[ -n "$out" ] || exit 0
if ! { mkdir -p "$dir" && printf '%s\\n' "$out" >"$file.tmp" && mv "$file.tmp" "$file"; }; then
  echo "Your memory could not be written to $file. Tell the user before other work."
  exit 0
fi
echo "Required: your memory was not carried over by any summary. Before you reply or do anything else, read $file in full with the Read tool, in chunks if needed. Do it every time, even when the request looks answerable without it."
`;

const SCRIPT = ".claude/hooks/bb-memory-session-start.sh";
/** Where the script puts a chat's memory. */
export const memoryFile = (home: string, threadId: string) => `${home}/nosync/bb-memory-${threadId}.md`;
const NO_SNAPSHOT = "No memory snapshot has been loaded yet. Use `bb assistants recall` for anything from before this session.\n";
export const HOOK_COMMAND = `sh "$CLAUDE_PROJECT_DIR/${SCRIPT}"`;

type Group = { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> };

/**
 * A settings.json's text (null for none) with this hook's entry added or removed, everything else kept;
 * null when it already is as wanted.
 */
export function withHook(settings: string | null, on: boolean): string | null {
  const parsed: unknown = settings === null || settings.trim() === "" ? {} : JSON.parse(settings);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
  const json = parsed as { hooks?: Record<string, Group[]> };
  const ours = (hook: { command?: string }) => hook.command === HOOK_COMMAND;
  const groups = json.hooks?.SessionStart ?? [];
  if (groups.some((group) => group.hooks?.some(ours)) === on) return null;
  const kept = on
    ? [...groups, { hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 30 }] }]
    : groups.map((group) => ({ ...group, hooks: group.hooks?.filter((hook) => !ours(hook)) })).filter((group) => group.hooks?.length !== 0);
  const { SessionStart: _, ...others } = json.hooks ?? {};
  const hooks = kept.length > 0 ? { ...others, SessionStart: kept } : others;
  const { hooks: __, ...rest } = json;
  const next = Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
  return `${JSON.stringify(next, null, 2)}\n`;
}

const missing = (error: unknown) => (error as { status?: unknown }).status === 404;

/**
 * Installs (`on`) or removes the hook in `home` on `hostId`. A settings file that changed meanwhile is
 * never overwritten. With `on`, `mainChat` gets a memory file if it has none, so the script warns it
 * should its very first load fail.
 */
export async function setHook(bb: BbPluginApi, { hostId, home }: { hostId: string; home: string }, on: boolean, mainChat?: string): Promise<void> {
  const files = bb.sdk.files;
  const settingsPath = `${home}/.claude/settings.json`;
  const current = await files.read({ hostId, path: settingsPath }).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  const text = current === null ? null : current.contentEncoding === "base64" ? Buffer.from(current.content, "base64").toString("utf8") : current.content;
  let next: string | null;
  try {
    next = withHook(text, on);
  } catch (error) {
    throw new Error(`${settingsPath}: ${error instanceof Error ? error.message : String(error)}; fix it, then try again`);
  }
  if (on) await files.write({ hostId, path: `${home}/${SCRIPT}`, content: HOOK_SCRIPT, createParents: true });
  // Lands only where no file is yet, so a real snapshot is never replaced.
  if (on && mainChat) await files.write({ hostId, path: memoryFile(home, mainChat), content: NO_SNAPSHOT, createParents: true, expectedSha256: null });
  if (next !== null) {
    const written = await files.write({ hostId, path: settingsPath, content: next, createParents: true, expectedSha256: current?.sha256 ?? null });
    if (written.outcome === "conflict") throw new Error(`${settingsPath} changed meanwhile; try again`);
  }
  if (!on) await files.remove({ hostId, path: `${home}/${SCRIPT}` }).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
}
