import { readFileSync } from "node:fs";
import { shapeReviewLabel, type Card } from "./store";
import type { IssueDetails } from "./issue";
import type { ImportedIssue } from "./issue-types";
import { renderInstructionTemplate } from "./prompt-template";
import type { ReviewBatch } from "./github-types";

const KICKOFF_FILES = ["workflow", "user-handoff", "imported-issue", "intake", "intake-imported", "lead", "lead-imported", "review-feedback"] as const;
const defaults: Readonly<Record<string, string>> = Object.fromEntries(KICKOFF_FILES.map((name) => [
  `kickoff/${name}.md`, readFileSync(new URL(`../workflows/kickoff/${name}.md`, import.meta.url), "utf8"),
]));

function document(name: string, documents: Readonly<Record<string, string>>) {
  const path = `kickoff/${name}.md`;
  const content = documents[path];
  if (content === undefined) throw new Error(`Missing instruction document ${path}`);
  return content;
}

export function userHandoff(documents = defaults): string {
  return document("user-handoff", documents);
}

export function workflowAccess(documents = defaults): string {
  return renderInstructionTemplate(document("workflow", documents), { user_handoff: userHandoff(documents) });
}

export const USER_HANDOFF = userHandoff();

export function reviewFeedbackPrompt(card: Card, batch: ReviewBatch, documents = defaults): string {
  const marker = `[pipeline-review:${card.id}:${batch.id}]`;
  const text = renderInstructionTemplate(document("review-feedback", documents), {
    batch_marker: marker, card_id: card.id,
    pr_url: card.prUrl ?? "null", head_sha: batch.headSha,
    feedback_urls: batch.feedback.map((item) => item.url).join("\n"),
    workflow_access: workflowAccess(documents), batch_id: batch.id,
  });
  return text.startsWith(marker) ? text : `${marker}\n${text}`;
}

function formatComments(comments: ImportedIssue["comments"]): string {
  return comments.length === 0 ? "none" : comments
    .map((comment) => `${comment.author} at ${comment.createdAt} (${comment.url}): ${comment.body}`)
    .join("\n\n");
}

function values(card: Card, documents: Readonly<Record<string, string>>): Record<string, string> {
  return {
    card_id: card.id, card_title: card.title, card_body: card.body,
    mode: card.mode ?? "unset", size: card.size ?? "unset", shape_review: shapeReviewLabel(card.shapeReview),
    local_notes: card.body.trim() || "(none)",
    workflow_access: workflowAccess(documents),
    imported_issue_rules: document("imported-issue", documents),
  };
}

export function intakePrompt(card: Card, projectName: string, documents = defaults): string {
  const imported = card.importedIssue;
  return renderInstructionTemplate(document(imported === null ? "intake" : "intake-imported", documents), {
    ...values(card, documents), project_name: projectName,
    ...(imported === null ? {} : {
      issue_number: String(imported.number), issue_title: imported.title,
      issue_url: imported.url, issue_state: imported.state, issue_updated_at: imported.updatedAt,
      labels: imported.labels.join(", ") || "none", assignees: imported.assignees.join(", ") || "none",
      issue_body: imported.body, comments: formatComments(imported.comments),
    }),
  });
}

export function leadPrompt(card: Card, issue: IssueDetails, documents = defaults): string {
  const imported = card.importedIssue;
  return renderInstructionTemplate(document(imported === null ? "lead" : "lead-imported", documents), {
    ...values(card, documents), issue_url: card.issueUrl ?? "null",
    issue_title: issue.title, issue_body: issue.body,
    kind: issue.labels.some((label) => label.toLowerCase() === "bug") ? "bug" : "feature",
    ...(imported === null ? {} : {
      issue_url: imported.url, issue_number: String(imported.number),
      issue_state: imported.state, issue_updated_at: imported.updatedAt,
      labels: issue.labels.join(", ") || "none", comments: formatComments(imported.comments),
    }),
  });
}
