import type { Card } from "./store";
import type { IssueDetails } from "./issue";

export function intakePrompt(card: Card, projectName: string): string {
  return `You are the intake for pipeline card ${card.id} in project ${projectName}. Use the pipeline-intake skill.
The user's note is below and their files are attached. This is limited information: start by asking the user what this is about.
---
${card.title}

${card.body}`;
}

export function leadPrompt(
  card: Card,
  issue: IssueDetails,
): string {
  const kind = issue.labels.includes("bug") ? "bug" : "feature";
  return `You are the lead for pipeline card ${card.id}: ${card.title}.
Ticket: ${card.issueUrl}. Kind: ${kind}. Tier: ${card.tier ?? "unsized"}.
Read the pipeline README (references/pipeline-README.md in the pipeline-plan skill) first and follow its routing by kind and tier. Report every column change and every stop for the user with \`bb pipeline report\` before you end the turn.
---
${issue.title}

${issue.body}`;
}
