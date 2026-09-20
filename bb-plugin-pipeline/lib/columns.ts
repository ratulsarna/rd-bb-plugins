export const COLUMNS = [
  "backlog",
  "todo",
  "planning",
  "plan_ready",
  "implementing",
  "reviewing",
  "qa",
  "pr",
  "pr_ready",
  "done",
] as const;

export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  backlog: "Backlog",
  todo: "To do",
  planning: "Planning",
  plan_ready: "Plan ready",
  implementing: "Implementing",
  reviewing: "Reviewing",
  qa: "QA",
  pr: "PR",
  pr_ready: "PR ready",
  done: "Done",
};

export function isColumn(value: string): value is Column {
  return (COLUMNS as readonly string[]).includes(value);
}
