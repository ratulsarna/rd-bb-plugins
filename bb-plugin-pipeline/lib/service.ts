import { randomUUID } from "node:crypto";
import type {
  PluginBbSdk,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import type { Column } from "./columns";
import type { IssueDetails } from "./issue";
import type { JevResult } from "./jev";
import {
  executionDefaults,
  executionSelectionSchema,
  validateExecutionSelections,
  type ExecutionDefaults,
  type ExecutionSelection,
  type ExecutionSettings,
} from "./execution";
import { intakePrompt, leadPrompt } from "./prompts";
import { resolveMachine } from "./machines";
import {
  environmentFor,
  kickoffRequest,
  type PipelineLaunchSettings,
  type PipelineRole,
} from "./spawn";
import type {
  Card,
  CardAttachment,
  CardStore,
  HistoryInput,
} from "./store";
import { ownerThread, requireStarted, roleThread } from "./card";
import { userAttentionReason } from "./notifications";
import { normalizePullRequestUrl } from "./github";
import {
  findPipelineThreadByMetadata,
  isThreadNotFound,
} from "./task-threads";

export interface PipelineSettings extends ExecutionSettings {
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
    intake?: Partial<ExecutionSelection>;
    lead?: Partial<ExecutionSelection>;
    title: string;
    body?: string;
    attachments?: CardAttachment[];
    start?: boolean;
    source: "ui" | "cli";
  }): Promise<Card>;
  getExecutionDefaults(): Promise<ExecutionDefaults>;
  setMachine(cardId: string, hostId: string): Promise<Card>;
  start(cardId: string, source: "ui" | "cli"): Promise<Card>;
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
  onThreadQueueChanged(thread: PipelineThread): Promise<void>;
  startupPass(): Promise<void>;
}

export interface PipelineServiceDependencies {
  store: CardStore;
  sdk: PluginBbSdk;
  getSettings(): Promise<PipelineSettings>;
  rememberExecution?(defaults: ExecutionDefaults): Promise<void>;
  readIssue(url: string): Promise<IssueDetails>;
  classify(input: {
    apiKey: string | undefined;
    threshold: number;
    lastText: string | null;
  }): Promise<JevResult>;
  log(message: string): void;
  publish(projectId: string): void;
  onAttention(card: Card, reason: string): void;
  onPrChanged?(card: Card): void;
  id?: () => string;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const MISSING_ISSUE_ERROR =
  "no issue yet: let intake finish, or pass --issue <url>";
const INTERRUPTED_START_ERROR =
  "intake: start interrupted before its thread was linked";
const START_RECOVERY_ERROR_PREFIX =
  "intake: could not check for an existing intake thread: ";

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

function parseThreshold(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 1 ? parsed : 0.7;
}

function launchSettings(
  settings: PipelineSettings,
  execution: ExecutionSelection,
): PipelineLaunchSettings {
  if (!(["accept-edits", "auto", "full"] as const).includes(
    settings.permissionMode as PipelineLaunchSettings["permissionMode"],
  )) {
    throw new Error(`invalid permission mode ${settings.permissionMode}`);
  }
  return {
    ...execution,
    permissionMode: settings.permissionMode as PipelineLaunchSettings["permissionMode"],
  };
}

function resolveExecution(
  defaults: ExecutionSelection,
  override: Partial<ExecutionSelection> | undefined,
): ExecutionSelection {
  const selected = executionSelectionSchema.partial().parse(override ?? {});
  const providerChanged = selected.providerId !== undefined && selected.providerId !== defaults.providerId;
  if (providerChanged && selected.model === undefined) {
    throw new Error("specify a model when changing the provider");
  }
  const resolved: Partial<ExecutionSelection> = { ...defaults, ...selected };
  if (providerChanged && selected.serviceTier === undefined) {
    delete resolved.serviceTier;
  }
  return executionSelectionSchema.parse(resolved);
}

function cancelledStartReason(role: PipelineRole): string {
  return `${role} start cancelled`;
}

function cancelledStartError(role: PipelineRole): string {
  return `${role}: start cancelled`;
}

function requireRunning(card: Card, action: string): void {
  if (card.runState === "running") return;
  throw new Error(
    `card ${card.id} is ${card.runState.replaceAll("_", " ")}; resume it before ${action}`,
  );
}

function sameLaunchContext(current: Card, snapshot: Card): boolean {
  return (
    current.ownerRole === snapshot.ownerRole &&
    current.startRequested === snapshot.startRequested &&
    current.intakeThreadId === snapshot.intakeThreadId &&
    current.leadThreadId === snapshot.leadThreadId
  );
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
  ): Card => {
    const previous = required(cardId);
    const card = changed(store.update(cardId, patch, history));
    const reason = userAttentionReason(card);
    if (reason !== null && userAttentionReason(previous) === null) {
      dependencies.onAttention(card, reason);
    }
    return card;
  };

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

  const buildKickoffRequest = async (card: Card, role: PipelineRole) => {
    const configured = await dependencies.getSettings();
    const execution = card[role] ?? executionDefaults(configured)[role];
    const settings = launchSettings(configured, execution);
    if (card.hostId === null) {
      throw new Error(
        "card has no machine assigned; run `bb pipeline set-machine <card-id> --machine <id-or-name>`",
      );
    }
    const project = await sdk.projects.get({ projectId: card.projectId });
    const issueUrl = normalizeIssueUrl(card.issueUrl);
    if (role === "lead" && issueUrl === null) {
      throw new Error(MISSING_ISSUE_ERROR);
    }
    const prompt =
      role === "intake"
        ? intakePrompt(card, project.name)
        : leadPrompt(card, await dependencies.readIssue(issueUrl!));
    return {
      project,
      hostId: card.hostId,
      request: kickoffRequest({ card, role, prompt, settings }),
    };
  };

  const buildLaunchRequest = async (card: Card, role: PipelineRole) => {
    const { project, hostId, request } = await buildKickoffRequest(card, role);
    const environment = await environmentFor(
      sdk, card.projectId, hostId, role, project,
    );
    return { ...request, environment };
  };

  const recordLaunchFailure = (
    card: Card,
    role: PipelineRole,
    cause: unknown,
  ): Card =>
    update(
      card.id,
      { launchError: `${role}: ${errorMessage(cause)}` },
      {
        kind: "launch_failed",
        source: "system",
        note: `${role}: ${errorMessage(cause)}`,
      },
    );

  const linkLaunchThread = (
    cardId: string,
    role: PipelineRole,
    threadId: string,
  ): Card => {
    const field = role === "intake" ? "intakeThreadId" : "leadThreadId";
    return update(
      cardId,
      {
        [field]: threadId,
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
        threadId,
        note: role,
      },
    );
  };

  const doLaunch = async (cardId: string, role: PipelineRole): Promise<Card> => {
    let card = required(cardId);
    const field = role === "intake" ? "intakeThreadId" : "leadThreadId";
    if (!card.startRequested || card.runState !== "running") return card;
    if (card[field] !== null) return card;

    let request;
    try {
      request = await buildLaunchRequest(card, role);
    } catch (cause) {
      const current = required(cardId);
      return current.startRequested && current.runState === "running" && sameLaunchContext(current, card)
        ? recordLaunchFailure(current, role, cause)
        : current;
    }

    const current = required(cardId);
    if (!current.startRequested || current.runState !== "running" || !sameLaunchContext(current, card)) {
      return current;
    }

    try {
      const thread = await sdk.threads.spawn(request);
      return linkLaunchThread(card.id, role, thread.id);
    } catch (cause) {
      return recordLaunchFailure(card, role, cause);
    }
  };

  const serializeLaunch = async (
    cardId: string,
    work: () => Promise<Card>,
  ): Promise<Card> => {
    const previous = launches.get(cardId) ?? Promise.resolve(required(cardId));
    const operation = previous
      .catch(() => required(cardId))
      .then(work);
    launches.set(cardId, operation);
    try {
      return await operation;
    } finally {
      if (launches.get(cardId) === operation) launches.delete(cardId);
    }
  };

  const launch = async (cardId: string, role: PipelineRole): Promise<Card> => {
    const card = required(cardId);
    requireStarted(card, "launching it");
    requireRunning(card, "launching it");
    return serializeLaunch(cardId, () => doLaunch(cardId, role));
  };

  const move = async (
    cardId: string,
    column: Column,
    source: "ui" | "cli",
  ): Promise<Card> => {
    const before = required(cardId);
    requireStarted(before, "moving it");
    requireRunning(before, "moving it");
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
    let initial = store.get(snapshot.id);
    if (
      initial === null ||
      initial.revision !== snapshot.revision ||
      roleThread(initial, role) !== threadId
    ) {
      return;
    }
    const thread = observation.kind === "thread" ? observation.thread : null;
    if (initial.runState !== "running") {
      if (
        initial.ownerRole === role &&
        (thread === null || thread.deletedAt !== null)
      ) {
        update(
          initial.id,
          { [role === "lead" ? "leadThreadId" : "intakeThreadId"]: null },
          {
            kind: "thread_gone",
            source: "system",
            threadId,
            note: "deleted",
          },
        );
      }
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

    if (thread.status === "pending") {
      const reason = cancelledStartReason(role);
      if (thread.queuedMessageCount === 0) {
        if (
          initial.launchError === cancelledStartError(role) &&
          sameAttention(initial, {
            needsUser: true,
            attentionReason: reason,
            attentionSource: "system",
            attentionUnknown: false,
          })
        ) {
          return;
        }
        update(
          initial.id,
          {
            launchError: cancelledStartError(role),
            needsUser: true,
            attentionReason: reason,
            attentionSource: "system",
            attentionUnknown: false,
            reportSignal: null,
          },
          {
            kind: "launch_failed",
            source: "system",
            threadId,
            note: reason,
          },
        );
      } else {
        const cancelledAttention =
          initial.attentionSource === "system" &&
          initial.attentionReason === reason;
        if (initial.launchError === null && !cancelledAttention) return;
        update(initial.id, {
          launchError: null,
          ...(cancelledAttention
            ? {
                needsUser: false,
                attentionReason: null,
                attentionSource: null,
                attentionUnknown: false,
                threadError: null,
                reportSignal: null,
              }
            : {}),
        });
      }
      return;
    }

    if (thread.status === "active" || thread.status === "starting") {
      update(initial.id, {
        needsUser: false,
        attentionReason: null,
        attentionSource: null,
        attentionUnknown: false,
        threadError: null,
        launchError: null,
        reportSignal: null,
      });
      return;
    }

    if (thread.status !== "idle") return;
    if (initial.launchError !== null) {
      initial = update(initial.id, { launchError: null });
    }
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
    const github = store.getGithub(initial.id);
    if (github?.awaitingReviewRevision === initial.revision && (github.batch === null || github.batch.state === "handled")) return;
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

  const isStartRecoveryError = (error: string | null): boolean =>
    error === INTERRUPTED_START_ERROR ||
    error?.startsWith(START_RECOVERY_ERROR_PREFIX) === true;

  const canRecoverStart = (current: Card, snapshot: Card): boolean =>
    current.startRequested &&
    current.runState === "running" &&
    current.column !== "done" &&
    current.intakeThreadId === null &&
    current.leadThreadId === null &&
    current.launchError === snapshot.launchError;

  const recoverInterruptedStart = async (
    snapshot: Card,
    markMissing: boolean,
  ): Promise<{ card: Card; missing: boolean }> => {
    let thread: PipelineThread | null;
    try {
      thread = await findPipelineThreadByMetadata(sdk, {
        projectId: snapshot.projectId,
        cardId: snapshot.id,
        role: "intake",
      });
    } catch (cause) {
      const current = required(snapshot.id);
      if (!canRecoverStart(current, snapshot)) {
        return { card: current, missing: false };
      }
      return {
        card: recordLaunchFailure(
          current,
          "intake",
          new Error(
            `could not check for an existing intake thread: ${errorMessage(cause)}`,
          ),
        ),
        missing: false,
      };
    }

    let current = required(snapshot.id);
    if (!canRecoverStart(current, snapshot)) {
      return { card: current, missing: false };
    }
    if (thread === null) {
      return {
        card: markMissing
          ? recordLaunchFailure(
              current,
              "intake",
              new Error("start interrupted before its thread was linked"),
            )
          : current,
        missing: true,
      };
    }
    const linked = linkLaunchThread(current.id, "intake", thread.id);
    if (linked.intakeThreadId === thread.id) {
      await reconcile(linked, "intake", {
        kind: "thread",
        thread,
        startup: true,
      });
    }
    return { card: required(snapshot.id), missing: false };
  };

  const start = async (
    cardId: string,
    source: "ui" | "cli",
  ): Promise<Card> => serializeLaunch(cardId, async () => {
    let card = required(cardId);
    if (card.startRequested) {
      const incomplete = store.getIncompleteStart(card.id);
      return incomplete === null
        ? card
        : (await recoverInterruptedStart(incomplete, true)).card;
    }
    if (card.column === "done") throw new Error("Completed tasks cannot be started");
    requireRunning(card, "starting it");
    card = update(
      card.id,
      {
        startRequested: true,
        needsUser: false,
        attentionReason: null,
        attentionSource: null,
        attentionUnknown: false,
        reportSignal: null,
        threadError: null,
        launchError: null,
      },
      {
        kind: "start_requested",
        source,
      },
    );
    return doLaunch(card.id, "intake");
  });

  const service: PipelineService = {
    async getExecutionDefaults() {
      return executionDefaults(await dependencies.getSettings());
    },
    async createCard(input) {
      const title = input.title.trim();
      if (title === "") throw new Error("title is required");
      const hostReference = input.hostId.trim();
      if (hostReference === "") {
        throw new Error("choose a machine for this card");
      }
      const defaults = executionDefaults(await dependencies.getSettings());
      const selected: ExecutionDefaults = {
        intake: resolveExecution(defaults.intake, input.intake),
        lead: resolveExecution(defaults.lead, input.lead),
      };
      const machine = await resolveMachine(
        dependencies.sdk,
        input.projectId,
        hostReference,
      );
      if (machine.status === "connected") {
        await validateExecutionSelections(dependencies.sdk, machine, selected);
      }
      const card = changed(
        store.create({
          id: (dependencies.id ?? (() => randomUUID().slice(0, 12)))(),
          projectId: input.projectId,
          hostId: machine.id,
          intake: selected.intake,
          lead: selected.lead,
          startRequested: input.start !== false,
          title,
          body: input.body ?? "",
          attachments: input.attachments ?? [],
          source: input.source,
        }),
      );
      const remember = dependencies.rememberExecution?.(selected).catch((cause) => {
        dependencies.log(
          `could not remember execution for card ${card.id}: ${errorMessage(cause)}`,
        );
      });
      if (!card.startRequested) {
        await remember;
        return card;
      }
      const [launched] = await Promise.all([launch(card.id, "intake"), remember]);
      return launched;
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
    start,
    launch,
    async retry(cardId) {
      const requested = required(cardId);
      requireStarted(requested, "retrying it");
      requireRunning(requested, "retrying it");
      if (requested.launchError === null) {
        throw new Error("nothing to retry");
      }
      return serializeLaunch(cardId, async () => {
        let card = required(cardId);
        if (!card.startRequested || card.runState !== "running") return card;
        if (card.launchError === null) return card;
        const role = card.ownerRole;
        const threadId = roleThread(card, role);
        if (threadId === null) {
          if (
            role === "intake" &&
            card.leadThreadId === null &&
            isStartRecoveryError(card.launchError)
          ) {
            const recovered = await recoverInterruptedStart(card, false);
            if (!recovered.missing) return recovered.card;
          }
          return doLaunch(cardId, role);
        }
        const recordRetryFailure = (cause: unknown): Card => {
          const current = required(cardId);
          return current.runState === "running" &&
            current.startRequested &&
            current.ownerRole === role &&
            roleThread(current, role) === threadId &&
            current.launchError !== null
            ? recordLaunchFailure(current, role, cause)
            : current;
        };

        let request;
        const launchRevision = card.revision;
        try {
          request = (await buildKickoffRequest(card, role)).request;
        } catch (cause) {
          return recordRetryFailure(cause);
        }

        card = required(cardId);
        if (
          card.revision !== launchRevision ||
          !card.startRequested ||
          card.runState !== "running" ||
          card.ownerRole !== role ||
          roleThread(card, role) !== threadId ||
          card.launchError === null
        ) {
          return card;
        }

        let thread: PipelineThread;
        try {
          thread = await sdk.threads.get({ threadId });
        } catch (cause) {
          if (isThreadNotFound(cause)) {
            await reconcile(card, role, { kind: "not-found", threadId });
            return required(cardId);
          }
          return recordRetryFailure(cause);
        }

        if (
          thread.deletedAt !== null ||
          thread.archivedAt !== null ||
          thread.status !== "pending" ||
          thread.queuedMessageCount > 0
        ) {
          await reconcile(card, role, { kind: "thread", thread });
          return required(cardId);
        }

        const beforeSend = required(cardId);
        if (
          beforeSend.revision !== card.revision ||
          !beforeSend.startRequested ||
          beforeSend.runState !== "running" ||
          beforeSend.ownerRole !== role ||
          roleThread(beforeSend, role) !== threadId ||
          beforeSend.launchError === null
        ) {
          return beforeSend;
        }

        try {
          await sdk.threads.send({
            threadId,
            mode: "auto",
            input: request.input,
            model: request.model,
            reasoningLevel: request.reasoningLevel,
            ...(request.serviceTier === undefined
              ? {}
              : { serviceTier: request.serviceTier }),
            permissionMode: request.permissionMode,
          });
        } catch (cause) {
          return recordRetryFailure(cause);
        }

        const current = required(cardId);
        if (
          current.revision !== card.revision ||
          !current.startRequested ||
          current.runState !== "running" ||
          current.ownerRole !== role ||
          roleThread(current, role) !== threadId
        ) {
          return current;
        }
        return update(current.id, {
          launchError: null,
          needsUser: false,
          attentionReason: null,
          attentionSource: null,
          attentionUnknown: false,
          threadError: null,
          reportSignal: null,
        });
      });
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
      if (
        (!card.startRequested || card.runState !== "running") &&
        input.column !== undefined &&
        (input.column !== card.column ||
          (input.column === "planning" && card.ownerRole !== "lead"))
      ) {
        requireStarted(card, "changing its phase or owner");
        requireRunning(card, "changing its phase or owner");
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
      if (input.prUrl !== undefined) {
        const prUrl = normalizePullRequestUrl(input.prUrl);
        if (prUrl === null) throw new Error("--pr requires a github.com pull request URL");
        patch.prUrl = prUrl;
      }
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
      if (
        next.startRequested &&
        next.runState === "running" &&
        input.column === "planning" &&
        next.leadThreadId === null
      ) {
        next = await launch(next.id, "lead");
      }
      if (next.prUrl !== card.prUrl) dependencies.onPrChanged?.(next);
      return next;
    },
    move,
    remove(cardId) {
      const card = required(cardId);
      requireRunning(card, "removing it");
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
    onThreadQueueChanged(thread) {
      return thread.status === "pending"
        ? reconcileThread(thread)
        : Promise.resolve();
    },
    async startupPass() {
      for (const snapshot of store.listIncompleteStarts()) {
        try {
          await serializeLaunch(snapshot.id, async () => {
            const current = store.getIncompleteStart(snapshot.id);
            return current === null
              ? required(snapshot.id)
              : (await recoverInterruptedStart(current, true)).card;
          });
        } catch (cause) {
          dependencies.log(
            `startup pass failed to recover card ${snapshot.id}: ${errorMessage(cause)}`,
          );
        }
      }
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
            baseline.runState === "running" &&
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
