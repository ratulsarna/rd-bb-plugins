// bb's normalized thread events as chat log records. bb gives every harness the same event shapes, so
// one converter serves Claude Code, Codex and Pi, for live logging and for importing old threads alike.
import type { Kind } from "./tree";

export type LogRecord = { kind: Kind; text: string; date: string };
export type EventRow = { seq: number; createdAt: number; type: string; data: any };

/** Items close with one of these: bb closes background tasks and background delegations only with their own. */
const ITEM_DONE = new Set(["item/completed", "item/backgroundTask/completed", "item/delegation/completed"]);

/** Event types the logger fetches. */
export const LOGGED_TYPES = ["client/turn/requested", "item/completed", "item/backgroundTask/completed", "item/delegation/completed"] as const;

/** Looking at memory is not news to remember; a failed or compound call is. Plain words only, no shell. */
const RECALL = /^bb assistants (recall|date)( +[\w-]+)*$/;
/** Codex runs each command through a shell, as `/bin/bash -lc 'bb assistants recall 21 1'`. */
const SHELL = /^(?:(?:\/[\w.-]+)*\/)?(?:bash|sh|zsh) -l?c (?:'([^']*)'|"([^"]*)")$/;

/** The command itself, out of one shell wrapper. */
function script(command: string): string {
  const wrapped = SHELL.exec(command.trim());
  return (wrapped ? (wrapped[1] ?? wrapped[2]) : command).trim();
}
const DROPPED = new Set(["reasoning", "plan", "contextCompaction", "userMessage"]);
/** Display and bookkeeping fields: not what the agent did. */
const NOISE = new Set(["id", "status", "presentation", "truncation", "parentToolCallId"]);
/** What a generic item answered, logged as its echo. */
const OUTPUT = ["result", "resultText", "summary", "error", "output", "aggregatedOutput"];

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO time with this server's offset, like `2026-09-01T10:00:00+05:30`. */
export function localIso(ms: number): string {
  const offset = -new Date(ms).getTimezoneOffset();
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offset);
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const STORED = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;

/**
 * A stored date as `bb assistants date` says it: the zone in words first, so a small model does not
 * misread the offset, then the stored value. A date without a readable offset is given as stored.
 */
export function spokenDate(stored: string): string {
  const parts = STORED.exec(stored);
  if (!parts) return stored;
  const [, day, time, offset] = parts;
  const zone = offset === "Z" || offset.slice(1) === "00:00" ? "UTC" : `UTC${offset}`;
  return `${day} ${time} ${zone} (${stored})`;
}

const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

function inputText(blocks: any[]): string {
  return blocks
    .filter((b) => b.visibility !== "agent-only")
    .map((b) =>
      b.type === "text" ? b.text : `[${b.type === "localFile" ? "file" : "image"}: ${b.name ?? b.path ?? b.url ?? ""}]`,
    )
    .join("\n")
    .trim();
}

/** bb's own manual compact: a turn whose whole input is its built-in `/compact` command. */
export function isBuiltinCompact(data: any): boolean {
  const blocks: any[] = (data.inputGroups ?? [data.input ?? []]).flat();
  const [only] = blocks;
  const [command] = only?.mentions ?? [];
  return (
    blocks.length === 1 &&
    only.type === "text" &&
    only.text.trim() === "/compact" &&
    only.mentions?.length === 1 &&
    command.resource.kind === "command" &&
    command.resource.name === "compact" &&
    command.resource.origin === "builtin"
  );
}

function turnRecords(data: any): Array<[Kind, string]> {
  // An instruction to the harness, not part of the chat.
  if (isBuiltinCompact(data)) return [];
  const sender: string | null = data.senderThreadId ?? null;
  // A side thread's or bb's own report reaches the chat as a message; the user typed the rest.
  const kind: Kind = sender || data.initiator === "system" ? "work" : "user";
  const tag = sender ? `[thread:${sender}] ` : "[system] ";
  const groups: any[][] = data.inputGroups ?? [data.input ?? []];
  return groups.flatMap((group) => {
    const body = inputText(group);
    if (!body) return [];
    return [[kind, kind === "work" && !body.startsWith("[") ? tag + body : body] as [Kind, string]];
  });
}

function itemRecords(item: any): Array<[Kind, string]> {
  // A nested subagent's own transcript: its root call and report are logged instead.
  if (!item || item.parentToolCallId || DROPPED.has(item.type)) return [];
  const out: Array<[Kind, string]> = [];
  const echo = (value: unknown) => {
    if (value !== undefined && value !== null && value !== "") out.push(["echo", text(value)]);
  };
  switch (item.type) {
    case "agentMessage":
      if (item.text) out.push(["unii", item.text]);
      break;
    case "commandExecution":
      if (RECALL.test(script(item.command)) && item.exitCode === 0) break;
      out.push(["tool", `$ ${item.command}`]);
      echo([item.aggregatedOutput ?? "", item.exitCode === undefined ? "" : `exit ${item.exitCode}`].filter(Boolean).join("\n"));
      break;
    case "fileChange":
      out.push(["tool", item.changes.map((c: any) => `edit ${c.kind} ${c.path}${c.movePath ? ` -> ${c.movePath}` : ""}`).join("\n")]);
      echo(item.changes.map((c: any) => c.diff).filter(Boolean).join("\n"));
      break;
    case "toolCall":
      out.push(["tool", `${item.tool} ${JSON.stringify(item.arguments ?? {})}`]);
      echo(item.error ? `error: ${item.error}` : item.result);
      break;
    case "webSearch":
      out.push(["tool", `webSearch ${item.queries.join("; ")}`]);
      echo(item.resultText);
      break;
    case "webFetch":
      out.push(["tool", `webFetch ${item.url}`]);
      echo(item.resultText);
      break;
    default: {
      const call = Object.fromEntries(Object.entries(item).filter(([k]) => k !== "type" && !NOISE.has(k) && !OUTPUT.includes(k)));
      const answer = Object.fromEntries(OUTPUT.filter((k) => item[k] !== undefined && item[k] !== null).map((k) => [k, item[k]]));
      out.push(["tool", `${item.type} ${JSON.stringify(call)}`]);
      if (Object.keys(answer).length > 0) echo(Object.keys(answer).length === 1 ? Object.values(answer)[0] : answer);
    }
  }
  return out;
}

/** Records one event makes, in order. Empty for events that are not part of the main chat. */
export function recordsOf(row: EventRow): LogRecord[] {
  const made =
    row.type === "client/turn/requested" ? turnRecords(row.data) : ITEM_DONE.has(row.type) ? itemRecords(row.data?.item) : [];
  const date = localIso(row.createdAt);
  return made.map(([kind, text]) => ({ kind, text, date }));
}
