import { SAM_HOME_SEGMENT } from "@/lib/assistant-identity";

export type RestartSeeds = {
  projectId: string;
  /** Stable assistant identity, or null when the home has none. */
  identity: string | null;
  /**
   * The journal vault mapped to the destination host, or null when unmapped.
   */
  vaultPath: string | null;
  archiveSource?: boolean;
  crossMachine?: boolean;
  /** Agent automations that still target the source conversation. */
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

/** A fresh conversation's context pointer and Sam's destination journal paths. */
export function restartPrompt(
  replaceThreadId: string | null,
  seeds: RestartSeeds,
  now: Date = new Date(),
): string {
  if (!replaceThreadId) return "";
  let lead = `Start a fresh root conversation. Use thread ${replaceThreadId} as context when needed.\n\n`;
  if (seeds.targetingAutomations.length > 0) {
    const lines = seeds.targetingAutomations
      .map((automation) => `- ${automation.name} (${automation.id})`)
      .join("\n");
    lead += seeds.archiveSource === true && !seeds.crossMachine
      ? `This conversation replaces and archives the source. Review these automations before repointing them; preserve each automation's machine and workspace requirements:\n${lines}\n\n`
      : `These automations still target the existing conversation. Keep their targets and machine/workspace requirements intact, including server-only jobs; starting this conversation does not migrate them:\n${lines}\n\n`;
  }
  const isSam = seeds.identity === `${seeds.projectId}:${SAM_HOME_SEGMENT}`;
  if (isSam && seeds.vaultPath) {
    const vault = seeds.vaultPath.replace(/\/+$/, "");
    const day = istDay(now);
    lead +=
      `Read ${vault}/Notes/Dated/${day}/${day}.md and ` +
      `${vault}/Notes/Memory/WeekSummary.md before answering.\n\n`;
  }
  return lead;
}
