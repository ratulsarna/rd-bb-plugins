import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createPipelineCli } from "./lib/cli";
import { createPipelineCapacity } from "./lib/capacity";
import { createPipelineControls } from "./lib/controls";
import { ownerThread } from "./lib/card";
import { rpcContract } from "./lib/contract";
import { REASONING_LEVELS } from "./lib/execution";
import { readIssue } from "./lib/issue";
import { askJev } from "./lib/jev";
import { listProjectMachines } from "./lib/machines";
import { createAttentionNotifier, userAttentionReason } from "./lib/notifications";
import { createPipelineService } from "./lib/service";
import { createCardStore, MIGRATIONS } from "./lib/store";

export { rpcContract } from "./lib/contract";
export type { Card, CardAttachment, CardHistory } from "./lib/store";

const CARDS_CHANGED = "cards:changed";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    providerId: {
      type: "string",
      label: "Intake provider",
      default: "claude-code",
    },
    model: {
      type: "string",
      label: "Intake model",
      default: "claude-fable-5-1",
    },
    reasoningLevel: {
      type: "select",
      label: "Intake reasoning",
      options: [...REASONING_LEVELS],
      default: "high",
    },
    serviceTier: {
      type: "select",
      label: "Intake service tier",
      options: ["default", "fast"],
    },
    leadProviderId: { type: "string", label: "Lead provider" },
    leadModel: { type: "string", label: "Lead model" },
    leadReasoningLevel: {
      type: "select",
      label: "Lead reasoning",
      options: [...REASONING_LEVELS],
    },
    leadServiceTier: {
      type: "select",
      label: "Lead service tier",
      options: ["default", "fast"],
    },
    permissionMode: {
      type: "select",
      label: "Permission",
      options: ["accept-edits", "auto", "full"],
      default: "full",
    },
    jevApiKey: {
      type: "string",
      label: "TypeSafe API key",
      secret: true,
    },
    jevThreshold: {
      type: "string",
      label: "Jev needs-you threshold (0.5..1)",
      default: "0.7",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db);
  const notifyAttention = createAttentionNotifier(bb);
  const capacity = createPipelineCapacity(bb, store);
  bb.experimental_hooks.on("message.dispatch", capacity.decide, { experimental_enforcement: "strict" });
  const service = createPipelineService({
    store,
    sdk: bb.sdk,
    getSettings: () => settings.get(),
    async rememberExecution({ intake, lead }) {
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
    },
    readIssue,
    classify: (input) =>
      askJev({
        ...input,
        log: (message) => bb.log.info(message),
      }),
    log: (message) => bb.log.warn(message),
    publish: (projectId) => bb.realtime.publish(CARDS_CHANGED, { projectId }),
    onAttention: notifyAttention,
  });
  const controls = createPipelineControls(bb, store, service);

  bb.rpc.register(rpcContract, {
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
    startCard({ cardId }) {
      return service.start(cardId, "ui");
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

  bb.cli.register(createPipelineCli({ service, store, sdk: bb.sdk, capacity, controls }));

  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    const card = store.getByThread(thread.id);
    if (card === null || ownerThread(card) !== thread.id || userAttentionReason(card) !== null) return;
    notifyAttention(card, interaction.payload.kind === "approval"
      ? "Approval waiting for you"
      : "Question waiting for you");
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

  bb.agents.configure((context) => {
    const role =
      context.origin.pluginId === bb.pluginId
        ? context.pluginMetadata.role
        : undefined;
    if (role === "lead") {
      return {
        tools: [],
        skills: [
          "pipeline",
          "pipeline-plan",
          "pipeline-implement",
          "pipeline-close-out",
          "pipeline-debug",
        ],
      };
    }
    if (role === "intake") {
      return { tools: [], skills: ["pipeline", "pipeline-intake"] };
    }
    return { tools: [], skills: ["pipeline"] };
  });

  bb.background.service("startup-pass", {
    async start(signal) {
      await controls.startup();
      await service.startupPass();
      await capacity.startup();
      await bb.experimental_hooks.recheck("message.dispatch");
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
}
