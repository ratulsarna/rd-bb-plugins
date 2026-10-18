import { SAM_HOME_SEGMENT } from "./assistant-identity";

export type RestartSeeds = {
  projectId: string;
  /** Stable assistant identity, or null when the home has none. */
  identity: string | null;
  /**
   * The journal vault mapped to the destination host, or null when unmapped.
   */
  vaultPath: string | null;
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

/** A fresh conversation's context pointer and Sam's destination journal paths. */
export function restartPrompt(
  replaceThreadId: string | null,
  seeds: RestartSeeds,
  now: Date = new Date(),
): string {
  if (!replaceThreadId) return "";
  let lead = `New chat. Your last one was thread ${replaceThreadId}. Check it if you need something from it.\n\n`;
  const isSam = seeds.identity === `${seeds.projectId}:${SAM_HOME_SEGMENT}`;
  if (isSam && seeds.vaultPath) {
    const vault = seeds.vaultPath.replace(/\/+$/, "");
    const day = istDay(now);
    lead +=
      "Before you answer, read today's journal and this week's summary:\n" +
      `- ${vault}/Notes/Dated/${day}/${day}.md\n` +
      `- ${vault}/Notes/Memory/WeekSummary.md\n\n`;
  }
  return lead;
}
