import { COLUMN_LABELS } from "@/lib/columns";
import { PAUSE_DELIVERY_PENDING } from "@/lib/card";
import { githubAttention } from "@/lib/github-state";
import type { Card } from "@/lib/store";
import type { GithubStatus } from "@/lib/github-types";

export interface TaskQueueState {
  reasons: string[];
  canRunNext: boolean;
  next: boolean;
}

export interface TaskPresentationState {
  label: string;
  kind:
    | "saving"
    | "done"
    | "unstarted"
    | "held"
    | "attention"
    | "queued"
    | "working"
    | "unknown"
    | "open";
}

export interface TaskDiagnostic {
  kind: "error" | "question" | "queue" | "unknown" | "working";
  message: string;
}

interface TaskStateContext {
  pending: boolean;
  questionOpen: boolean;
  queue: TaskQueueState | null;
  occupied?: boolean;
}

export function taskQuestionOpen(card: Card, questionOpen: boolean): boolean {
  return card.startRequested &&
    card.column !== "done" &&
    (card.runState === "running" || card.runState === "pause_requested") &&
    questionOpen;
}

function liveAttention(card: Card): boolean {
  return card.startRequested && card.column !== "done" && card.runState === "running";
}

function controlFailure(card: Card): string | null {
  return card.runState === "pause_requested" && card.controlError === PAUSE_DELIVERY_PENDING
    ? null : card.controlError;
}

export function taskStage(card: Card): string {
  return COLUMN_LABELS[card.column];
}

export function taskPresentationState(
  card: Card,
  context: TaskStateContext,
): TaskPresentationState {
  if (context.pending) return { label: "Saving", kind: "saving" };
  if (card.column === "done") return { label: "Done", kind: "done" };

  if (card.runState === "pause_requested") {
    return { label: "Pause requested", kind: "held" };
  }
  if (card.runState === "pausing") return { label: "Pausing", kind: "held" };
  if (card.runState === "paused") return { label: "Paused", kind: "held" };
  if (card.runState === "stopping") return { label: "Stopping", kind: "held" };
  if (!card.startRequested) return { label: "Not started", kind: "unstarted" };

  if (taskNeedsAttention(card, context.questionOpen)) {
    return { label: "Needs you", kind: "attention" };
  }
  if (context.queue !== null) {
    return {
      label: context.queue.next ? "Next" : "Queued",
      kind: "queued",
    };
  }
  if (card.attentionUnknown) return { label: "Unknown", kind: "unknown" };
  if (card.reportSignal === "working") return { label: "Working", kind: "working" };
  return { label: "Open", kind: "open" };
}

export function taskDiagnostics(
  card: Card,
  context: Pick<TaskStateContext, "questionOpen" | "queue" | "occupied">,
): TaskDiagnostic[] {
  if (card.column === "done") {
    return context.occupied === true ? [{ kind: "working", message: "Work still running" }] : [];
  }
  if (!card.startRequested) return [];

  const diagnostics: TaskDiagnostic[] = [];
  if (card.launchError !== null) {
    diagnostics.push({ kind: "error", message: `Launch failed: ${card.launchError}` });
  }
  const failure = controlFailure(card);
  if (failure !== null) {
    diagnostics.push({ kind: "error", message: failure });
  }
  if (card.threadError !== null) {
    diagnostics.push({ kind: "error", message: `Thread failed: ${card.threadError}` });
  }

  if (liveAttention(card) && card.needsUser) {
    diagnostics.push({
      kind: "question",
      message: card.attentionReason ?? "Needs your input",
    });
  } else if (taskQuestionOpen(card, context.questionOpen)) {
    diagnostics.push({ kind: "question", message: "Question waiting for you" });
  }
  if (liveAttention(card)) {
    const problem = githubAttention(card);
    if (problem !== null) {
      const failedSync = card.github !== null && card.github.error !== null;
      diagnostics.push({
        kind: failedSync ? "error" : "question",
        message: failedSync ? `GitHub sync failed: ${problem}` : problem,
      });
    }
  }

  if (card.runState === "running" && context.queue !== null) {
    for (const reason of context.queue.reasons) {
      diagnostics.push({ kind: "queue", message: reason });
    }
  }
  if (liveAttention(card) && card.attentionUnknown) {
    diagnostics.push({ kind: "unknown", message: "Idle · awaiting status" });
  }

  return diagnostics.filter(
    (diagnostic, index, all) =>
      all.findIndex((candidate) => candidate.message === diagnostic.message) === index,
  );
}

export function taskPrimaryReason(
  card: Card,
  context: Pick<TaskStateContext, "questionOpen" | "queue" | "occupied">,
): TaskDiagnostic | null {
  return taskDiagnostics(card, context)[0] ?? null;
}

export function taskNeedsAttention(card: Card, questionOpen: boolean): boolean {
  if (!card.startRequested || card.column === "done") return false;
  if (controlFailure(card) !== null) return true;
  if (card.runState === "pause_requested") return questionOpen;
  if (card.runState !== "running") return false;
  return card.needsUser ||
    card.launchError !== null ||
    card.threadError !== null ||
    questionOpen ||
    githubAttention(card) !== null;
}

export type GithubTone = "neutral" | "ok" | "warn" | "error";

export interface TaskGithubSummary {
  label: string;
  tone: GithubTone;
}

export type GithubCheckState = GithubStatus["checks"][number]["state"];

export const GITHUB_CHECK_LABELS: Record<GithubCheckState, string> = {
  pending: "Pending",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function taskGithubSummary(card: Card): TaskGithubSummary | null {
  const github = card.github;
  if (github === null) return null;
  if (github.state === "merged") return { label: "Merged", tone: "ok" };
  if (github.state === "closed") return { label: "PR closed", tone: "error" };
  if (github.error !== null) return { label: "Sync failed", tone: "error" };
  if (github.checks.some((check) => check.state === "failed")) return { label: "Checks failing", tone: "error" };
  if (github.review === "feedback") return { label: "Feedback for lead", tone: "neutral" };
  if (github.review === "clear") {
    if (github.mergeable === "conflicting") return { label: "Conflicts", tone: "warn" };
    return github.mergeable === "mergeable"
      ? { label: "Review settled", tone: "ok" }
      : { label: "Merge unknown", tone: "neutral" };
  }
  if (github.checks.some((check) => check.state === "pending")) return { label: "Checks running", tone: "neutral" };
  if (github.review === "waiting") return { label: "Awaiting review", tone: "neutral" };
  if (github.draft) return { label: "Draft", tone: "neutral" };
  return { label: "Review unknown", tone: "neutral" };
}

export function taskGithubStateLabel(card: Card): string {
  const github = card.github;
  if (github === null) return "";
  if (github.state === "merged") return "Merged";
  if (github.state === "closed") return "Closed";
  return github.draft ? "Open · Draft" : "Open";
}

export function taskGithubReviewLabel(card: Card): string {
  const github = card.github;
  if (github === null) return "";
  if (github.review === "waiting") return "Awaiting review";
  if (github.review === "feedback") return "Feedback for lead";
  if (github.review === "unknown") return "Review status unknown";
  return "Review settled";
}

export function taskGithubMergeLabel(card: Card): string {
  const github = card.github;
  if (github === null) return "";
  if (github.mergeable === "mergeable") return "No conflicts";
  if (github.mergeable === "conflicting") return "Conflicting";
  return "Merge status unknown";
}

const GITHUB_FOLLOWUP_LABELS: Record<NonNullable<GithubStatus["followup"]>, string> = {
  pending: "Review follow-up pending",
  queued: "Review feedback queued for lead",
  delivered: "Review feedback delivered to lead",
  handled: "Review feedback handled",
  cancelled: "Review follow-up cancelled",
};

export function taskGithubFollowup(card: Card): string | null {
  const github = card.github;
  return github === null || github.followup === null ? null : GITHUB_FOLLOWUP_LABELS[github.followup];
}

export function taskGithubRetryable(card: Card): boolean {
  const github = card.github;
  if (github === null) return false;
  return github.followup === "pending"
    || github.followup === "queued"
    || github.followup === "cancelled"
    || (github.followup === "delivered" && github.error !== null);
}

export function taskGithubSyncedLabel(card: Card): string {
  const github = card.github;
  if (github === null || github.syncedAt === null) return "Not synced yet";
  const at = new Date(github.syncedAt);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${at.getUTCFullYear()}-${part(at.getUTCMonth() + 1)}-${part(at.getUTCDate())} ${part(at.getUTCHours())}:${part(at.getUTCMinutes())} UTC`;
}
