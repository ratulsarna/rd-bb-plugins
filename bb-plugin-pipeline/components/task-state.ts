import { COLUMN_LABELS } from "@/lib/columns";
import type { Card } from "@/lib/store";

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
  kind: "error" | "question" | "queue" | "unknown";
  message: string;
}

interface TaskStateContext {
  pending: boolean;
  questionOpen: boolean;
  queue: TaskQueueState | null;
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
  context: Pick<TaskStateContext, "questionOpen" | "queue">,
): TaskDiagnostic[] {
  if (!card.startRequested || card.column === "done") return [];

  const diagnostics: TaskDiagnostic[] = [];
  if (card.launchError !== null) {
    diagnostics.push({ kind: "error", message: `Launch failed: ${card.launchError}` });
  }
  if (card.controlError !== null) {
    diagnostics.push({ kind: "error", message: card.controlError });
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
  context: Pick<TaskStateContext, "questionOpen" | "queue">,
): TaskDiagnostic | null {
  return taskDiagnostics(card, context)[0] ?? null;
}

export function taskNeedsAttention(card: Card, questionOpen: boolean): boolean {
  if (!card.startRequested || card.column === "done") return false;
  if (card.runState === "pause_requested") return questionOpen;
  if (card.runState !== "running") return false;
  return card.needsUser ||
    card.launchError !== null ||
    card.threadError !== null ||
    questionOpen;
}
