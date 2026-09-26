import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createPipelineCli } from "./lib/cli";
import { createPipelineCapacity } from "./lib/capacity";
import { createPipelineControls } from "./lib/controls";
import { ownerThread } from "./lib/card";
import { rpcContract } from "./lib/contract";
import { SETTINGS, settingsView, settingsPatch } from "./lib/settings";
import { integrationStatus } from "./lib/integrations";
import { readIssue } from "./lib/issue";
import { askJev } from "./lib/jev";
import { createGithubSync } from "./lib/github-sync";
import { createIssueImporter } from "./lib/issue-import";
import { listProjectMachines } from "./lib/machines";
import { createAttentionNotifier, userAttentionReason } from "./lib/notifications";
import { createPipelineService } from "./lib/service";
import { createCardStore, MIGRATIONS } from "./lib/store";

export { rpcContract } from "./lib/contract";
export type { Card, CardAttachment, CardHistory } from "./lib/store";

const CARDS_CHANGED = "cards:changed";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTINGS);
  let currentSettings = await settings.get();
  let settingsWrite = Promise.resolve();
  function serializeSettings<T>(work: () => Promise<T>): Promise<T> {
    const next = settingsWrite.then(work);
    settingsWrite = next.then(() => undefined, () => undefined);
    return next;
  }
  bb.onDispose(() => settingsWrite);

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db);
  const notifyAttention = createAttentionNotifier(bb, () => currentSettings);
  const capacity = createPipelineCapacity(bb, store, () => currentSettings.taskLimit);
  const github = createGithubSync({ bb, store, getSettings: () => settings.get(), notify: notifyAttention });
  const issues = createIssueImporter({ sdk: bb.sdk, store, publish: (projectId) => bb.realtime.publish(CARDS_CHANGED, { projectId }) });
  bb.experimental_hooks.on("message.dispatch", async (context) => {
    const reviewDecision = await github.decide(context);
    if (reviewDecision !== null) return reviewDecision;
    const decision = await capacity.decide(context);
    return (await github.decide(context)) ?? decision;
  }, { experimental_enforcement: "strict" });
  const service = createPipelineService({
    store,
    sdk: bb.sdk,
    getSettings: () => settings.get(),
    rememberExecution({ intake, lead }) {
      return serializeSettings(async () => {
        if (!currentSettings.rememberExecution) return;
        await settings.experimental_set({
          providerId: intake.providerId,
          model: intake.model,
          reasoningLevel: intake.reasoningLevel,
          serviceTier: intake.serviceTier ?? null,
          leadProviderId: lead.providerId,
          leadModel: lead.model,
          leadReasoningLevel: lead.reasoningLevel,
          leadServiceTier: lead.serviceTier ?? null,
        });
      });
    },
    readIssue,
    refreshImportedIssue: (cardId) => issues.refresh(cardId),
    classify: (input) =>
      askJev({
        ...input,
        log: (message) => bb.log.info(message),
      }),
    log: (message) => bb.log.warn(message),
    publish: (projectId) => bb.realtime.publish(CARDS_CHANGED, { projectId }),
    onAttention: notifyAttention,
    onPrChanged: (card) => { void github.sync(card.id).catch((cause) => bb.log.warn(String(cause))); },
  });
  const controls = createPipelineControls(bb, store, service);

  settings.onChange((next, previous) => {
    currentSettings = next;
    bb.realtime.publish("settings:changed", {});
    if (next.taskLimit !== previous.taskLimit || next.autoReviewFollowup !== previous.autoReviewFollowup) {
      bb.realtime.publish(CARDS_CHANGED, {});
      void bb.experimental_hooks.recheck("message.dispatch").catch((cause) => bb.log.warn(String(cause)));
    }
    if (next.autoReviewFollowup !== previous.autoReviewFollowup) {
      void github.poll().catch((cause) => bb.log.warn(String(cause)));
    }
  });

  bb.rpc.register(rpcContract, {
    async getSettings() {
      return settingsView(await settings.get());
    },
    updateSettings(input) {
      return serializeSettings(async () => settingsView(await settings.experimental_set(settingsPatch(input, await settings.get()))));
    },
    async settingsMachines() {
      const hosts = await bb.sdk.hosts.list();
      return { machines: hosts.map(({ id, name, status }) => ({ id, name, status })) };
    },
    async integrationStatus() {
      return integrationStatus(bb.sdk, Boolean((await settings.get()).jevApiKey?.trim()));
    },
    executionDefaults() {
      return service.getExecutionDefaults();
    },
    async listProjects() {
      const projects = await bb.sdk.projects.list();
      return { projects: projects.map(({ id, name }) => ({ id, name })) };
    },
    async listCards({ projectId, includeDone }) {
      return {
        cards: store.list(projectId, includeDone),
        queue: await capacity.snapshot(projectId),
      };
    },
    syncGithub: ({ cardId }) => github.sync(cardId),
    listIssues: ({ projectId, page }) => issues.list(projectId, page),
    importIssues: ({ projectId, numbers }) => issues.import(projectId, numbers),
    syncIssue: ({ cardId }) => issues.refresh(cardId),
    retryReview: ({ cardId }) => github.retry(cardId),
    async setRunNext({ cardId, enabled }) {
      await capacity.setRunNext(cardId, enabled);
      return { ok: true as const };
    },
    async listMachines({ projectId }) {
      return { machines: await listProjectMachines(bb.sdk, projectId) };
    },
    setMachine({ cardId, hostId }) {
      return service.setMachine(cardId, hostId);
    },
    addCard(input) {
      return service.createCard({ ...input, source: "ui" });
    },
    startCard({ cardId, ...options }) {
      return service.start(cardId, "ui", options);
    },
    moveCard({ cardId, column }) {
      return service.move(cardId, column, "ui");
    },
    retryLaunch({ cardId }) {
      return service.retry(cardId);
    },
    pauseCard: ({ cardId }) => controls.pause(cardId),
    resumeCard: ({ cardId }) => controls.resume(cardId),
    stopCard: ({ cardId }) => controls.stop(cardId),
    removeCard({ cardId }) {
      return { removed: service.remove(cardId) };
    },
    async showCard({ cardId }) {
      const card = store.get(cardId);
      if (card === null) throw new Error(`unknown card ${cardId}`);
      const queue = await capacity.snapshot(card.projectId);
      const queued = queue.some((machine) => machine.waiting.some((item) => item.cardId === cardId));
      return { card, history: store.history(cardId), queued };
    },
  });

  bb.cli.register(createPipelineCli({ service, store, sdk: bb.sdk, capacity, controls, github, issues }));

  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    const card = store.getByThread(thread.id);
    if (card === null || ownerThread(card) !== thread.id || userAttentionReason(card) !== null) return;
    notifyAttention(card, interaction.payload.kind === "approval"
      ? "Approval waiting for you"
      : "Question waiting for you", "questions");
  });

  for (const event of ["thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      await controls.onActivity(thread);
      if (event === "thread.archived" || event === "thread.deleted") await capacity.onQueueChanged(thread);
      await bb.experimental_hooks.recheck("message.dispatch");
      await capacity.publish(thread);
    });
  }
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    await controls.onActivity(thread);
    if (thread.status === "active" || thread.status === "starting") return;
    await bb.experimental_hooks.recheck("message.dispatch");
    await capacity.publish(thread);
  });
  for (const event of ["message.queued", "message.dispatched", "message.cancelled"] as const) {
    bb.events.on(event, async ({ entry }) => {
      github.onMessage(event === "message.queued" ? "queued" : event === "message.dispatched" ? "dispatched" : "cancelled", entry);
      if (event === "message.cancelled") controls.onMessageCancelled(entry);
      const thread = await bb.sdk.threads.get({ threadId: entry.threadId, experimental_includeDeleted: true });
      if (event !== "message.dispatched") await service.onThreadQueueChanged(thread);
      if (event === "message.dispatched") await capacity.onStarted(thread);
      else await capacity.onQueueChanged(thread, event === "message.queued" ? entry : undefined);
      if (event === "message.cancelled") await controls.onActivity(thread);
      await capacity.publish(thread);
    });
  }

  bb.events.on("thread.active", async ({ thread }) => {
    await capacity.onStarted(thread);
    await controls.onActivity(thread, true);
    await service.onThreadActive(thread);
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    service.onThreadIdle(thread, lastAssistantText),
  );
  bb.events.on("thread.failed", ({ thread, error }) =>
    service.onThreadFailed(thread, error),
  );
  bb.events.on("thread.archived", ({ thread }) =>
    service.onThreadGone(thread),
  );
  bb.events.on("thread.unarchived", ({ thread }) =>
    service.onThreadUnarchived(thread),
  );
  bb.events.on("thread.deleted", ({ thread }) =>
    service.onThreadGone(thread),
  );

  bb.background.schedule("github-sync", "* * * * *", () => github.poll());
  bb.background.service("startup-pass", {
    async start(signal) {
      await controls.startup();
      await service.startupPass();
      await capacity.startup();
      await github.poll();
      await bb.experimental_hooks.recheck("message.dispatch");
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
}
