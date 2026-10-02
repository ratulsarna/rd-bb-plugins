const CARD_FIELDS = ["card_id", "card_title", "card_body", "mode", "size", "local_notes", "workflow_access", "imported_issue_rules"];
const ISSUE_FIELDS = ["issue_number", "issue_title", "issue_url", "issue_state", "issue_updated_at", "labels", "comments"];

export const INSTRUCTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "kickoff/workflow.md": ["user_handoff"],
  "kickoff/user-handoff.md": [],
  "kickoff/imported-issue.md": [],
  "kickoff/intake.md": [...CARD_FIELDS, "project_name"],
  "kickoff/intake-imported.md": [...CARD_FIELDS, "project_name", ...ISSUE_FIELDS, "assignees", "issue_body"],
  "kickoff/lead.md": [...CARD_FIELDS, "issue_url", "issue_title", "issue_body", "kind"],
  "kickoff/lead-imported.md": [...CARD_FIELDS, ...ISSUE_FIELDS, "issue_body", "kind"],
  "kickoff/review-feedback.md": ["batch_marker", "card_id", "pr_url", "head_sha", "feedback_urls", "workflow_access", "batch_id"],
};

export function validateInstructionFields(id: string, content: string): void {
  const fields = INSTRUCTION_FIELDS[id];
  if (fields === undefined) return;
  for (const match of content.matchAll(/\{\{([a-z_]+)\}\}/g)) {
    if (!fields.includes(match[1]!)) throw new Error(`Unknown instruction field {{${match[1]}}} in ${id}`);
  }
}

export function renderInstructionTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Unknown instruction field {{${name}}}`);
    return values[name]!;
  });
}
