// The session context steered into the first turn of a Sam thread: today's
// note, the week summary, and where older history lives. The marker on the
// first line lets the scribe skip this message when it digests the thread.

export const SESSION_CONTEXT_MARKER = "[Session context from sam-scribe]";

export interface SessionContextInput {
  /** IST calendar day, YYYY-MM-DD. */
  day: string;
  notePath: string;
  note: string;
  weekPath: string;
  week: string;
}

/** Calendar day in Asia/Kolkata for an instant. */
export function istDay(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function sessionContext(input: SessionContextInput): string {
  const note = input.note.trim() || "(empty so far)";
  const week = input.week.trim() || "(not built yet)";
  return [
    SESSION_CONTEXT_MARKER,
    "This is context, not a request. Do not reply to it.",
    "",
    `Today is ${input.day} (IST).`,
    "",
    `## Today's note (${input.notePath})`,
    note,
    "",
    `## Week summary (${input.weekPath})`,
    week,
    "",
    "## Older history",
    "Notes/Memory/MonthSummary.md covers this month before the week window; Notes/Memory/HalfYearSummary.md covers the months before that; Notes/Memory/.cache/daily_summaries.json has every compressed day. Read them when a question reaches back further than the week.",
    "Journal lines are dated events, not current state. Before acting on anything that reads as a condition, check the system or config it describes.",
  ].join("\n");
}
