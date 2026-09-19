import { randomUUID } from "node:crypto";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { Column } from "./columns";
import type { IssueDetails } from "./issue";
import type { JevResult } from "./jev";
import { intakePrompt, leadPrompt } from "./prompts";
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

export interface PipelineSettings {
  hostId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  permissionMode: string;
  jevApiKey?: string;
  jevThreshold: string;
}

export interface PipelineThread {
  id: string;
  status?: string;
  activeBackgroundAgentCount: number;
}

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
    title: string;
    body?: string;
    attachments?: CardAttachment[];
    source: "ui" | "cli";
  }): Promise<Card>;
  launch(cardId: string, role: PipelineRole): Promise<Card>;
  retry(cardId: string): Promise<Card>;
  report(input: ReportInput): Promise<Card>;
  move(cardId: string, column: Column, source: "ui" | "cli"): Promise<Card>;
  remove(cardId: string, source: "ui" | "cli"): boolean;
  onThreadActive(thread: PipelineThread): Promise<void>;
  onThreadIdle(thread: PipelineThread, lastText: string | null): Promise<void>;
  onThreadFailed(thread: PipelineThread, error: string | null): Promise<void>;
  onThreadGone(
    thread: PipelineThread,
    action: "archived" | "deleted",
  ): Promise<void>;
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
    column: Column;
    lastText: string | null;
  }): Promise<JevResult>;
  publish(projectId: string): void;
  id?: () => string;
}

export function ownerThread(card: Card): string | null {
  return card.leadThreadId ?? card.intakeThreadId;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseThreshold(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.7;
}

function launchSettings(settings: PipelineSettings): PipelineLaunchSettings {
  if (settings.hostId.trim() === "") throw new Error("host id is empty");
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
      const project = await sdk.projects.get({ projectId: card.projectId });
      const environment = await environmentFor(
        sdk,
        card.projectId,
        settings.hostId,
        role,
        project,
      );
      if (role === "lead" && card.issueUrl === null) {
        throw new Error(
          `no issue yet: let intake finish, or \`bb pipeline report --card ${card.id} --issue <url>\`, then retry`,
        );
      }
      const prompt =
        role === "intake"
          ? intakePrompt(card, project.name)
          : leadPrompt(card, await dependencies.readIssue(card.issueUrl!));
      const thread = await sdk.threads.spawn(
        spawnRequest({ card, role, prompt, environment, settings }),
      );
      card = update(
        card.id,
        {
          [field]: thread.id,
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
    let card = before;
    if (before.column !== column) {
      card = update(
        cardId,
        { column },
        {
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

  const service: PipelineService = {
    async createCard(input) {
      const title = input.title.trim();
      if (title === "") throw new Error("title is required");
      const card = changed(
        store.create({
          id: (dependencies.id ?? (() => randomUUID().slice(0, 12)))(),
          projectId: input.projectId,
          title,
          body: input.body ?? "",
          attachments: input.attachments ?? [],
          source: input.source,
        }),
      );
      return launch(card.id, "intake");
    },
    launch,
    async retry(cardId) {
      const card = required(cardId);
      if (card.launchError === null) throw new Error("nothing to retry");
      const role = card.launchError.startsWith("lead:") ? "lead" : "intake";
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

      const patch: Parameters<CardStore["update"]>[1] = {};
      if (input.issueUrl !== undefined) patch.issueUrl = input.issueUrl;
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

      const moved = input.column !== undefined && input.column !== card.column;
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
          : input.needsYou !== undefined || input.working
            ? {
                kind: "attention",
                source: "report",
                threadId: input.threadId,
                note: input.needsYou ?? "working",
              }
            : undefined,
      );
      if (input.column === "planning" && next.leadThreadId === null) {
        next = await launch(next.id, "lead");
      }
      return next;
    },
    move,
    remove(cardId, source) {
      const card = required(cardId);
      const removed = store.remove(cardId, source);
      if (removed) dependencies.publish(card.projectId);
      return removed;
    },
    async onThreadActive(thread) {
      const card = store.getByThread(thread.id);
      if (card === null) return;
      if (ownerThread(card) !== thread.id) {
        nonOwnerHistory(card, thread.id, "attention", "ignored non-owner active");
        return;
      }
      update(card.id, {
        needsUser: false,
        attentionReason: null,
        attentionSource: null,
        attentionUnknown: false,
        threadError: null,
        reportSignal: null,
      });
    },
    async onThreadIdle(thread, lastText) {
      const initial = store.getByThread(thread.id);
      if (initial === null) return;
      if (ownerThread(initial) !== thread.id) {
        nonOwnerHistory(initial, thread.id, "attention", "ignored non-owner idle");
        return;
      }

      if (initial.leadThreadId === null) {
        const nextColumn = initial.column === "backlog" ? "todo" : initial.column;
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
                threadId: thread.id,
              }
            : {
                kind: "attention",
                source: "system",
                threadId: thread.id,
                note: "intake is waiting for you",
              },
        );
        return;
      }

      if (
        thread.activeBackgroundAgentCount > 0 ||
        initial.reportSignal === "needs_you"
      ) {
        return;
      }
      const settings = await dependencies.getSettings();
      const verdict =
        (lastText?.trim() ?? "") === "" || !settings.jevApiKey
          ? { decision: "unknown" as const, probability: null }
          : await dependencies.classify({
              apiKey: settings.jevApiKey,
              threshold: parseThreshold(settings.jevThreshold),
              column: initial.column,
              lastText,
            });
      const current = store.get(initial.id);
      if (current === null || current.revision !== initial.revision) return;

      if (verdict.decision === "needs") {
        update(
          initial.id,
          {
            needsUser: true,
            attentionReason: (lastText ?? "").slice(-200),
            attentionSource: "jev",
            attentionUnknown: false,
          },
          {
            kind: "attention",
            source: "jev",
            threadId: thread.id,
            note: "needs user",
          },
        );
      } else if (verdict.decision === "no") {
        update(initial.id, {
          needsUser: false,
          attentionReason: null,
          attentionSource: null,
          attentionUnknown: false,
        });
      } else {
        update(initial.id, {
          needsUser: false,
          attentionReason: null,
          attentionSource: null,
          attentionUnknown: true,
        });
      }
    },
    async onThreadFailed(thread, error) {
      const card = store.getByThread(thread.id);
      if (card === null) return;
      const reason = `thread failed: ${error ?? "unknown error"}`;
      if (ownerThread(card) !== thread.id) {
        nonOwnerHistory(card, thread.id, "thread_failed", reason);
        return;
      }
      update(
        card.id,
        {
          threadError: error ?? "unknown error",
          needsUser: true,
          attentionReason: reason,
          attentionSource: "system",
          attentionUnknown: false,
        },
        {
          kind: "thread_failed",
          source: "system",
          threadId: thread.id,
          note: error,
        },
      );
    },
    async onThreadGone(thread, action) {
      const card = store.getByThread(thread.id);
      if (card === null) return;
      if (ownerThread(card) !== thread.id) {
        nonOwnerHistory(card, thread.id, "thread_gone", action);
        return;
      }
      update(
        card.id,
        {
          needsUser: true,
          attentionReason: `thread ${action}`,
          attentionSource: "system",
          attentionUnknown: false,
        },
        {
          kind: "thread_gone",
          source: "system",
          threadId: thread.id,
          note: action,
        },
      );
    },
    async startupPass() {
      for (const card of store.listActiveWithOwner()) {
        const threadId = ownerThread(card)!;
        try {
          const thread = await sdk.threads.get({ threadId });
          if (thread.status === "error") {
            await service.onThreadFailed(thread, "thread is in error state");
          } else if (thread.status === "active" || thread.status === "starting") {
            await service.onThreadActive(thread);
          } else if (
            thread.status === "idle" &&
            !card.needsUser &&
            !card.attentionUnknown &&
            card.reportSignal !== "needs_you"
          ) {
            const output = await sdk.threads.output({ threadId });
            await service.onThreadIdle(thread, output.output);
          }
        } catch {
          await service.onThreadGone(
            { id: threadId, activeBackgroundAgentCount: 0 },
            "archived",
          );
        }
      }
    },
  };

  return service;
}
