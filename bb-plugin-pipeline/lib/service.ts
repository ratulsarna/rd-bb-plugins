import { randomUUID } from "node:crypto";
import type {
  PluginBbSdk,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import type { Column } from "./columns";
import type { IssueDetails } from "./issue";
import type { JevResult } from "./jev";
import { intakePrompt, leadPrompt } from "./prompts";
import { resolveMachine } from "./machines";
import {
  environmentFor,
  spawnRequest,
  type PipelineLaunchSettings,
  type PipelineRole,
} from "./spawn";
import type {
  Card,
  CardAttachment,
  CardStore,
  HistoryInput,
} from "./store";
import { ownerThread, roleThread } from "./store";

export interface PipelineSettings {
  providerId: string;
  model: string;
  reasoningLevel: string;
  permissionMode: string;
  jevApiKey?: string;
  jevThreshold: string;
}

export type PipelineThread =
  PluginThreadEventPayloads["thread.created"]["thread"];

export interface ReportInput {
  threadId?: string;
  cardId?: string;
  column?: Column;
  needsYou?: string;
  working?: boolean;
  issueUrl?: string;
  prUrl?: string;
  tier?: "trivial" | "small" | "standard";
}

export interface PipelineService {
  createCard(input: {
    projectId: string;
    hostId: string;
    title: string;
    body?: string;
    attachments?: CardAttachment[];
    source: "ui" | "cli";
  }): Promise<Card>;
  setMachine(cardId: string, hostId: string): Promise<Card>;
  launch(cardId: string, role: PipelineRole): Promise<Card>;
  retry(cardId: string): Promise<Card>;
  report(input: ReportInput): Promise<Card>;
  move(cardId: string, column: Column, source: "ui" | "cli"): Promise<Card>;
  remove(cardId: string): boolean;
  onThreadActive(thread: PipelineThread): Promise<void>;
  onThreadIdle(thread: PipelineThread, lastText: string | null): Promise<void>;
  onThreadFailed(thread: PipelineThread, error: string | null): Promise<void>;
  onThreadGone(thread: PipelineThread): Promise<void>;
  onThreadUnarchived(thread: PipelineThread): Promise<void>;
  startupPass(): Promise<void>;
}

export interface PipelineServiceDependencies {
  store: CardStore;
  sdk: PluginBbSdk;
  getSettings(): Promise<PipelineSettings>;
  readIssue(url: string): Promise<IssueDetails>;
  classify(input: {
    apiKey: string | undefined;
    threshold: number;
    lastText: string | null;
  }): Promise<JevResult>;
  log(message: string): void;
  publish(projectId: string): void;
  id?: () => string;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const MISSING_ISSUE_ERROR =
  "no issue yet: let intake finish, or pass --issue <url>";

function normalizeIssueUrl(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function sameAttention(
  card: Card,
  target: Pick<
    Card,
    | "needsUser"
    | "attentionReason"
    | "attentionSource"
    | "attentionUnknown"
  >,
): boolean {
  return (
    card.needsUser === target.needsUser &&
    card.attentionReason === target.attentionReason &&
    card.attentionSource === target.attentionSource &&
    card.attentionUnknown === target.attentionUnknown
  );
}

function isThreadNotFound(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; status?: unknown };
  return error.status === 404 || error.code === "thread_not_found";
}

function parseThreshold(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 1 ? parsed : 0.7;
}

function launchSettings(settings: PipelineSettings): PipelineLaunchSettings {
  if (settings.providerId.trim() === "") throw new Error("provider id is empty");
  if (settings.model.trim() === "") throw new Error("model is empty");
  if (!(["low", "medium", "high", "xhigh", "max"] as const).includes(
    settings.reasoningLevel as PipelineLaunchSettings["reasoningLevel"],
  )) {
    throw new Error(`invalid reasoning level ${settings.reasoningLevel}`);
  }
  if (!(["accept-edits", "auto", "full"] as const).includes(
    settings.permissionMode as PipelineLaunchSettings["permissionMode"],
  )) {
    throw new Error(`invalid permission mode ${settings.permissionMode}`);
  }
  return settings as PipelineLaunchSettings;
}

export function createPipelineService(
  dependencies: PipelineServiceDependencies,
): PipelineService {
  const { store, sdk } = dependencies;
  const launches = new Map<string, Promise<Card>>();

  const required = (id: string): Card => {
    const card = store.get(id);
    if (card === null) {
      throw new Error(`unknown card ${id}; run \`bb pipeline list\` to see cards`);
    }
    return card;
  };

  const changed = (card: Card): Card => {
    dependencies.publish(card.projectId);
    return card;
  };

  const update = (
    cardId: string,
    patch: Parameters<CardStore["update"]>[1],
    history?: HistoryInput,
  ): Card => changed(store.update(cardId, patch, history));

  const nonOwnerHistory = (
    card: Card,
    threadId: string,
    kind: string,
    note: string,
  ): void => {
    store.recordHistory(card.id, {
      kind,
      source: "system",
      threadId,
      note,
    });
  };

  const doLaunch = async (cardId: string, role: PipelineRole): Promise<Card> => {
    let card = required(cardId);
    const field = role === "intake" ? "intakeThreadId" : "leadThreadId";
    if (card[field] !== null) return card;

    try {
      const configured = await dependencies.getSettings();
      const settings = launchSettings(configured);
      if (card.hostId === null) {
        throw new Error(
          "card has no machine assigned; run `bb pipeline set-machine <card-id> --machine <id-or-name>`",
        );
      }
      const project = await sdk.projects.get({ projectId: card.projectId });
      const environment = await environmentFor(
        sdk,
        card.projectId,
        card.hostId,
        role,
        project,
      );
      const issueUrl = normalizeIssueUrl(card.issueUrl);
      if (role === "lead" && issueUrl === null) {
        throw new Error(MISSING_ISSUE_ERROR);
      }
      const prompt =
        role === "intake"
          ? intakePrompt(card, project.name)
          : leadPrompt(card, await dependencies.readIssue(issueUrl!));
      const thread = await sdk.threads.spawn(
        spawnRequest({ card, role, prompt, environment, settings }),
      );
      card = update(
        card.id,
        {
          [field]: thread.id,
          needsUser: false,
          attentionReason: null,
          attentionSource: null,
          attentionUnknown: false,
          threadError: null,
          launchError: null,
          reportSignal: null,
        },
        {
          kind: "launched",
          source: "system",
          threadId: thread.id,
          note: role,
        },
      );
      return card;
    } catch (cause) {
      return update(
        card.id,
        { launchError: `${role}: ${errorMessage(cause)}` },
        {
          kind: "launch_failed",
          source: "system",
          note: `${role}: ${errorMessage(cause)}`,
        },
      );
    }
  };

  const launch = async (cardId: string, role: PipelineRole): Promise<Card> => {
    const previous = launches.get(cardId) ?? Promise.resolve(required(cardId));
    const operation = previous
      .catch(() => required(cardId))
      .then(() => doLaunch(cardId, role));
    launches.set(cardId, operation);
    try {
      return await operation;
    } finally {
      if (launches.get(cardId) === operation) launches.delete(cardId);
    }
  };

  const move = async (
    cardId: string,
    column: Column,
    source: "ui" | "cli",
  ): Promise<Card> => {
    const before = required(cardId);
    if (column === "planning" && normalizeIssueUrl(before.issueUrl) === null) {
      throw new Error(MISSING_ISSUE_ERROR);
    }
    let card = before;
    if (before.column !== column || (column === "planning" && before.ownerRole !== "lead")) {
      card = update(
        cardId,
        {
          column,
          ...(column === "planning" ? { ownerRole: "lead" as const } : {}),
        },
        before.column === column
          ? undefined
          : {
              kind: "moved",
              fromColumn: before.column,
              toColumn: column,
              source,
            },
      );
    }
    if (column === "planning" && card.leadThreadId === null) {
      card = await launch(cardId, "lead");
    }
    return card;
  };

  type ReconcileInput =
    | {
        kind: "thread";
        thread: PipelineThread;
        lastText?: string | null;
        error?: string | null;
        startup?: boolean;
      }
    | { kind: "not-found"; threadId: string };

  const reconcile = async (
    snapshot: Card,
    role: PipelineRole,
    observation: ReconcileInput,
  ): Promise<void> => {
    const threadId =
      observation.kind === "thread"
        ? observation.thread.id
        : observation.threadId;
    const initial = store.get(snapshot.id);
    if (
      initial === null ||
      initial.revision !== snapshot.revision ||
      roleThread(initial, role) !== threadId
    ) {
      return;
    }
    if (initial.ownerRole !== role) {
      if (observation.kind === "thread") {
        const state =
          observation.thread.deletedAt !== null
            ? "deleted"
            : observation.thread.archivedAt !== null
              ? "archived"
              : observation.thread.status;
        nonOwnerHistory(
          initial,
          threadId,
          state === "error" ? "thread_failed" : "attention",
          `ignored non-owner ${state}`,
        );
      }
      return;
    }

    const thread = observation.kind === "thread" ? observation.thread : null;
    if (thread === null || thread.deletedAt !== null) {
      update(
        initial.id,
        {
          [role === "lead" ? "leadThreadId" : "intakeThreadId"]: null,
          launchError: `${role}: thread deleted`,
          needsUser: true,
          attentionReason: "thread deleted",
          attentionSource: "system",
          attentionUnknown: false,
          reportSignal: null,
        },
        {
          kind: "thread_gone",
          source: "system",
          threadId,
          note: "deleted",
        },
      );
      return;
    }

    if (thread.archivedAt !== null) {
      update(
        initial.id,
        {
          needsUser: true,
          attentionReason: "thread archived",
          attentionSource: "system",
          attentionUnknown: false,
          reportSignal: null,
        },
        {
          kind: "thread_gone",
          source: "system",
          threadId,
          note: "archived",
        },
      );
      return;
    }

    if (thread.status === "error") {
      const failure =
        (observation.kind === "thread" ? observation.error : null) ??
        "thread is in error state";
      const reason = `thread failed: ${failure}`;
      update(
        initial.id,
        {
          threadError: failure,
          needsUser: true,
          attentionReason: reason,
          attentionSource: "system",
          attentionUnknown: false,
          reportSignal: null,
        },
        {
          kind: "thread_failed",
          source: "system",
          threadId,
          note: failure,
        },
      );
      return;
    }

    if (thread.status === "active" || thread.status === "starting") {
      update(initial.id, {
        needsUser: false,
        attentionReason: null,
        attentionSource: null,
        attentionUnknown: false,
        threadError: null,
        reportSignal: null,
      });
      return;
    }

    if (thread.status !== "idle") return;
    if (thread.activeBackgroundAgentCount > 0) return;
    if (role === "intake") {
      const nextColumn = initial.column === "backlog" ? "todo" : initial.column;
      if (initial.reportSignal === "needs_you") {
        if (nextColumn !== initial.column) {
          update(
            initial.id,
            { column: nextColumn },
            {
              kind: "moved",
              fromColumn: initial.column,
              toColumn: nextColumn,
              source: "system",
              threadId,
            },
          );
        }
        return;
      }
      if (
        initial.column === nextColumn &&
        sameAttention(initial, {
          needsUser: true,
          attentionReason: "intake is waiting for you",
          attentionSource: "system",
          attentionUnknown: false,
        })
      ) {
        return;
      }
      update(
        initial.id,
        {
          column: nextColumn,
          needsUser: true,
          attentionReason: "intake is waiting for you",
          attentionSource: "system",
          attentionUnknown: false,
        },
        initial.column === "backlog"
          ? {
              kind: "moved",
              fromColumn: "backlog",
              toColumn: "todo",
              source: "system",
              threadId,
            }
          : {
              kind: "attention",
              source: "system",
              threadId,
              note: "intake is waiting for you",
            },
      );
      return;
    }
    if (initial.reportSignal === "needs_you") return;
    if (
      observation.kind === "thread" &&
      observation.startup &&
      (initial.attentionSource === "jev" || initial.attentionUnknown)
    ) {
      return;
    }

    const lastText =
      (observation.kind === "thread" ? observation.lastText : null) ?? null;
    const settings = await dependencies.getSettings();
    const verdict = await dependencies.classify({
      apiKey: settings.jevApiKey,
      threshold: parseThreshold(settings.jevThreshold),
      lastText,
    });
    const current = store.get(initial.id);
    if (current === null || current.revision !== initial.revision) return;

    if (verdict.decision === "needs") {
      const reason = (lastText ?? "").slice(-200);
      if (sameAttention(initial, {
        needsUser: true,
        attentionReason: reason,
        attentionSource: "jev",
        attentionUnknown: false,
      })) {
        return;
      }
      update(
        initial.id,
        {
          needsUser: true,
          attentionReason: reason,
          attentionSource: "jev",
          attentionUnknown: false,
        },
        {
          kind: "attention",
          source: "jev",
          threadId,
          note: "needs user",
        },
      );
    } else if (verdict.decision === "no") {
      if (sameAttention(initial, {
        needsUser: false,
        attentionReason: null,
        attentionSource: null,
        attentionUnknown: false,
      })) {
        return;
      }
      update(initial.id, {
        needsUser: false,
        attentionReason: null,
        attentionSource: null,
        attentionUnknown: false,
      });
    } else {
      if (sameAttention(initial, {
        needsUser: false,
        attentionReason: null,
        attentionSource: null,
        attentionUnknown: true,
      })) {
        return;
      }
      update(initial.id, {
        needsUser: false,
        attentionReason: null,
        attentionSource: null,
        attentionUnknown: true,
      });
    }
  };

  const reconcileThread = async (
    thread: PipelineThread,
    details: { lastText?: string | null; error?: string | null } = {},
  ): Promise<void> => {
    const card = store.getByThread(thread.id);
    if (card === null) return;
    const role = card.leadThreadId === thread.id ? "lead" : "intake";
    await reconcile(card, role, { kind: "thread", thread, ...details });
  };

  const service: PipelineService = {
    async createCard(input) {
      const title = input.title.trim();
      if (title === "") throw new Error("title is required");
      const hostReference = input.hostId.trim();
      if (hostReference === "") {
        throw new Error("choose a machine for this card");
      }
      const machine = await resolveMachine(
        dependencies.sdk,
        input.projectId,
        hostReference,
      );
      const card = changed(
        store.create({
          id: (dependencies.id ?? (() => randomUUID().slice(0, 12)))(),
          projectId: input.projectId,
          hostId: machine.id,
          title,
          body: input.body ?? "",
          attachments: input.attachments ?? [],
          source: input.source,
        }),
      );
      return launch(card.id, "intake");
    },
    async setMachine(cardId, hostId) {
      const card = required(cardId);
      const hostReference = hostId.trim();
      if (hostReference === "") {
        throw new Error("choose a machine for this card");
      }
      const machine = await resolveMachine(
        dependencies.sdk,
        card.projectId,
        hostReference,
      );
      if (card.hostId === machine.id) return card;
      return changed(store.setHost(card.id, machine.id));
    },
    launch,
    async retry(cardId) {
      const card = required(cardId);
      const role = card.ownerRole;
      if (card.launchError === null || roleThread(card, role) !== null) {
        throw new Error("nothing to retry");
      }
      return launch(cardId, role);
    },
    async report(input) {
      if (input.needsYou !== undefined && input.working) {
        throw new Error("--needs-you and --working cannot be used together");
      }
      const card =
        input.cardId === undefined
          ? input.threadId === undefined
            ? null
            : store.getByThread(input.threadId)
          : store.get(input.cardId);
      if (card === null) {
        const target = input.cardId ?? input.threadId ?? "current thread";
        throw new Error(
          `unknown card or pipeline thread ${target}; run \`bb pipeline list\` to see cards`,
        );
      }
      if (
        input.cardId === undefined &&
        input.threadId !== undefined &&
        ownerThread(card) !== input.threadId
      ) {
        throw new Error(
          `card ${card.id} is now led by ${ownerThread(card) ?? "no thread"}`,
        );
      }
      const issueUrl =
        input.issueUrl === undefined
          ? undefined
          : normalizeIssueUrl(input.issueUrl);
      if (input.issueUrl !== undefined && issueUrl === null) {
        throw new Error(MISSING_ISSUE_ERROR);
      }
      if (
        input.column === "planning" &&
        (issueUrl ?? normalizeIssueUrl(card.issueUrl)) === null
      ) {
        throw new Error(MISSING_ISSUE_ERROR);
      }

      const patch: Parameters<CardStore["update"]>[1] = {};
      if (issueUrl !== undefined) patch.issueUrl = issueUrl;
      if (input.prUrl !== undefined) patch.prUrl = input.prUrl;
      if (input.tier !== undefined) patch.tier = input.tier;
      if (input.needsYou !== undefined) {
        patch.needsUser = true;
        patch.attentionReason = input.needsYou;
        patch.attentionSource = "report";
        patch.attentionUnknown = false;
        patch.reportSignal = "needs_you";
      } else if (input.working) {
        patch.needsUser = false;
        patch.attentionReason = null;
        patch.attentionSource = null;
        patch.attentionUnknown = false;
        patch.reportSignal = "working";
      }
      if (input.column !== undefined) patch.column = input.column;
      if (input.column === "planning") patch.ownerRole = "lead";

      const moved = input.column !== undefined && input.column !== card.column;
      const attentionHistory =
        input.needsYou !== undefined || input.working
          ? {
              kind: "attention",
              source: "report",
              threadId: input.threadId,
              note: input.needsYou ?? "working",
            }
          : undefined;
      let next = update(
        card.id,
        patch,
        moved
          ? {
              kind: "moved",
              fromColumn: card.column,
              toColumn: input.column,
              source: "report",
              threadId: input.threadId,
            }
          : attentionHistory,
      );
      if (moved && attentionHistory !== undefined) {
        store.recordHistory(card.id, attentionHistory);
      }
      if (input.column === "planning" && next.leadThreadId === null) {
        next = await launch(next.id, "lead");
      }
      return next;
    },
    move,
    remove(cardId) {
      const card = required(cardId);
      const removed = store.remove(cardId);
      if (removed) dependencies.publish(card.projectId);
      return removed;
    },
    onThreadActive(thread) {
      return reconcileThread(thread);
    },
    onThreadIdle(thread, lastText) {
      return reconcileThread(thread, { lastText });
    },
    onThreadFailed(thread, error) {
      return reconcileThread(thread, { error });
    },
    onThreadGone(thread) {
      return reconcileThread(thread);
    },
    onThreadUnarchived(thread) {
      return reconcileThread(thread);
    },
    async startupPass() {
      for (const card of store.listActiveWithOwner()) {
        const threadId = ownerThread(card)!;
        let thread;
        try {
          thread = await sdk.threads.get({ threadId });
        } catch (cause) {
          if (isThreadNotFound(cause)) {
            const baseline = store.get(card.id);
            if (baseline !== null) {
              await reconcile(baseline, baseline.ownerRole, {
                kind: "not-found",
                threadId,
              });
            }
          } else {
            dependencies.log(
              `startup pass failed for thread ${threadId}: ${errorMessage(cause)}`,
            );
          }
          continue;
        }
        const baseline = store.get(card.id);
        if (baseline === null) continue;
        try {
          let lastText: string | null | undefined;
          if (
            thread.status === "idle" &&
            thread.deletedAt === null &&
            thread.archivedAt === null
          ) {
            const output = await sdk.threads.output({ threadId });
            lastText = output.output;
          }
          await reconcile(baseline, baseline.ownerRole, {
            kind: "thread",
            thread,
            lastText,
            startup: true,
          });
        } catch (cause) {
          dependencies.log(
            `startup pass failed for thread ${threadId}: ${errorMessage(cause)}`,
          );
        }
      }
    },
  };

  return service;
}
