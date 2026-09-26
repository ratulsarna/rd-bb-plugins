import type { Card } from "./store";
import type { IssueDetails } from "./issue";
import type { ImportedIssue } from "./issue-types";

export const IMPORTED_ISSUE_RULES = "The source issue on GitHub is read-only: never edit its body, labels, or comments, never comment on it, and never close, reopen, or reassign it. Keep clarified scope, decisions, and classification in the card's local notes instead: write them to a file and run `bb pipeline report --body-file <path>` to store them on the card. The tier is stored on the card; do not turn it into issue labels.";

function formatComments(comments: ImportedIssue["comments"]): string {
  if (comments.length === 0) {
    return "none";
  }
  return comments
    .map((comment) => `${comment.author} at ${comment.createdAt} (${comment.url}): ${comment.body}`)
    .join("\n\n");
}

export const USER_HANDOFF = "The Pipeline card tracks state only. Put questions, explanations, walkthroughs, and approval requests in your user-facing chat reply. When waiting, state the decision and relevant options there. Use `bb pipeline report --needs-you` for a short status label; it does not post a chat message or collect an answer. Wait for the user's reply in this thread.";

export const WORKFLOW_ACCESS = `This task follows the Pipeline workflow. Read its instructions with \`bb pipeline instructions <phase>\` and its templates with \`bb pipeline instructions <phase> --file <relative-path>\`. Load each phase when you reach it and follow its exit instructions. Intake ends with the documented report that hands off to a separate lead. The lead continues between phases in its own thread after the required user approval; no separate slash command is needed. Keep every user-approval gate in those instructions.
${USER_HANDOFF}`;

export function intakePrompt(card: Card, projectName: string): string {
  const imported = card.importedIssue;
  if (imported !== null) {
    return `You are the intake for pipeline card ${card.id} in project ${projectName}.
${WORKFLOW_ACCESS}
Run \`bb pipeline instructions intake\` first and follow it. This card imports a GitHub issue, so its "Imported issues" section replaces the filing steps.
${IMPORTED_ISSUE_RULES}
Source issue #${imported.number}: ${imported.title}
${imported.url} (${imported.state}; last updated ${imported.updatedAt})
Labels: ${imported.labels.join(", ") || "none"}. Assignees: ${imported.assignees.join(", ") || "none"}. Tier: ${card.tier ?? "unsized"} (stored on the card).
--- source issue body ---
${imported.body}
--- source issue comments ---
${formatComments(imported.comments)}
--- local notes on the card (not on GitHub) ---
${card.body.trim() || "(none)"}
This issue already exists. Do not ask what this is about and do not file a new one. Read the source, the comments, and the local notes, then ask only for what they leave open. Before you hand off, persist the clarified scope with \`bb pipeline report --body-file <path>\`.`;
  }
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
  const imported = card.importedIssue;
  if (imported !== null) {
    return `You are the lead for pipeline card ${card.id}: ${card.title}.
Ticket: ${imported.url} (#${imported.number}, ${imported.state}; last updated ${imported.updatedAt}). Source labels: ${issue.labels.join(", ") || "none"}. Tier: ${card.tier ?? "unsized"}.
${IMPORTED_ISSUE_RULES}
Classify before routing: the intake's classification in the local notes below wins, and the source labels are only a fallback; the source is read-only, so a missing bug label does not mean feature.
${WORKFLOW_ACCESS}
Run \`bb pipeline instructions\` first and follow its routing by kind and tier. Report every column change and every stop for the user with \`bb pipeline report\` before you end the turn.
--- source issue ---
${issue.title}

${issue.body}
--- source issue comments ---
${formatComments(imported.comments)}
--- local notes on the card (not on GitHub) ---
${card.body.trim() || "(none)"}`;
  }
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
