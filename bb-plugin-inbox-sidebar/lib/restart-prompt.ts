import { SAM_HOME_SEGMENT } from "./assistant-identity";

export type RestartSeeds = {
  projectId: string;
  /** Stable assistant identity, or null when the home has none. */
  identity: string | null;
  /**
   * The journal vault mapped to the destination host, or null when unmapped.
   */
  vaultPath: string | null;
  /** Agent automations that still target the source conversation. */
  targetingAutomations: Array<{ id: string; name: string }>;
};

function automationList(automations: RestartSeeds["targetingAutomations"]): string {
  return automations.map(({ id, name }) => `- ${name} (${id})`).join("\n");
}

/** Final guidance follows the validated choice, even for a previously saved draft. */
export function restartAutomationPolicy(
  sourceThreadId: string,
  archiveSource: boolean,
  automations: RestartSeeds["targetingAutomations"],
): string {
  const choice = archiveSource
    ? "Replacement was selected. Review automations targeting the source before repointing them."
    : "The source is being kept. Keep automation targets on the source intact.";
  return `Use thread ${sourceThreadId} as context when needed.\n` +
    `Final automation policy for source thread ${sourceThreadId}; this supersedes any conflicting source-retention or replacement guidance in the draft:\n` +
    `${choice} Preserve each automation's machine and workspace requirements, including server-only jobs. Starting this conversation does not migrate automations.\n` +
    (automations.length ? `Current automations targeting the source:\n${automationList(automations)}\n` : "");
}

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
    lead += `Automations currently targeting the source; final guidance follows the selected creation mode:\n${automationList(seeds.targetingAutomations)}\n\n`;
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
