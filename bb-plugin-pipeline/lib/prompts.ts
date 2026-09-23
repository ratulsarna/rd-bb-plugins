import type { Card } from "./store";
import type { IssueDetails } from "./issue";

export const WORKFLOW_SKILL_ACCESS = "This task explicitly invokes the Pipeline workflow. Find skills by name with `bb skill list --json` and read them with `bb skill show <id>`. Read supporting files with `bb skill show <id> --path <relative-path>`. Use these commands for each phase when the workflow calls for it, keeping its user-approval gates. Load only the current phase and its needed references.";

export function intakePrompt(card: Card, projectName: string): string {
  return `You are the intake for pipeline card ${card.id} in project ${projectName}.
${WORKFLOW_SKILL_ACCESS}
Read and follow pipeline-intake first.
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
${WORKFLOW_SKILL_ACCESS}
Read the pipeline README (references/pipeline-README.md in the pipeline-plan skill) first and follow its routing by kind and tier. Report every column change and every stop for the user with \`bb pipeline report\` before you end the turn.
---
${issue.title}

${issue.body}`;
}
