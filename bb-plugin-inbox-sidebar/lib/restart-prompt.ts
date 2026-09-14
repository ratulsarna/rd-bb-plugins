export type RestartSeeds = {
  homePath: string | null;
  /** Agent automations that still target the thread being replaced. */
  targetingAutomations: Array<{ id: string; name: string }>;
};

/** YYYY-MM-DD on Sam's clock, whatever timezone the browser is in. */
function istDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The draft's lead line, with a repoint note when automations still point at
 * the thread being replaced, and Sam's reading for the day. It rides in the
 * first user message, so the freshly-born assistant sees it and knows to
 * repoint (its own id is the new one) or tell you.
 *
 * Only Sam keeps a journal (fleet AGENTS.md), so only Sam's home gets the
 * reading line: today's note and the week summary the nightly compress
 * builds. A pointer, not the text; Sam reads the files herself.
 */
export function restartPrompt(
  replaceThreadId: string | null,
  seeds: RestartSeeds,
  now: Date = new Date(),
): string {
  if (!replaceThreadId) return "";
  let lead = `Continue from thread ${replaceThreadId}.\n\n`;
  if (seeds.targetingAutomations.length > 0) {
    const lines = seeds.targetingAutomations
      .map((automation) => `- ${automation.name} (${automation.id})`)
      .join("\n");
    lead +=
      `This thread replaces the one above. These automations still target ` +
      `the archived thread and need repointing to this thread's id:\n${lines}\n\n`;
  }
  if (seeds.homePath?.replace(/\/+$/, "").endsWith("/sam")) {
    const day = istDay(now);
    lead +=
      `Read ~/ObsidianVault/Notes/Dated/${day}/${day}.md and ` +
      `~/ObsidianVault/Notes/Memory/WeekSummary.md before answering.\n\n`;
  }
  return lead;
}
