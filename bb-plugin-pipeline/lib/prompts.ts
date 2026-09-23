import type { Card } from "./store";
import type { IssueDetails } from "./issue";

export const WORKFLOW_ACCESS = "This task follows the Pipeline workflow. Read its instructions with `bb pipeline instructions <phase>` and its templates with `bb pipeline instructions <phase> --file <relative-path>`. Load each phase when you reach it and follow its exit instructions. Intake ends with the documented report that hands off to a separate lead. The lead continues between phases in its own thread after the required user approval; no separate slash command is needed. Keep every user-approval gate in those instructions.";

export function intakePrompt(card: Card, projectName: string): string {
  return `You are the intake for pipeline card ${card.id} in project ${projectName}.
${WORKFLOW_ACCESS}
Run \`bb pipeline instructions intake\` first and follow it.
The user's note is below and their files are attached. This is limited information: start by asking the user what this is about.
---
${card.title}

${card.body}`;
}

export function leadPrompt(
  card: Card,
  issue: IssueDetails,
): string {
  const kind = issue.labels.some((label) => label.toLowerCase() === "bug")
    ? "bug"
    : "feature";
  return `You are the lead for pipeline card ${card.id}: ${card.title}.
Ticket: ${card.issueUrl}. Kind: ${kind}. Tier: ${card.tier ?? "unsized"}.
${WORKFLOW_ACCESS}
Run \`bb pipeline instructions\` first and follow its routing by kind and tier. Report every column change and every stop for the user with \`bb pipeline report\` before you end the turn.
---
${issue.title}

${issue.body}`;
}
