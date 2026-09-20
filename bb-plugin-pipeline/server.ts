import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createPipelineCli } from "./lib/cli";
import { createPipelineCapacity } from "./lib/capacity";
import { rpcContract } from "./lib/contract";
import { readIssue } from "./lib/issue";
import { askJev } from "./lib/jev";
import { listProjectMachines } from "./lib/machines";
import { createPipelineService } from "./lib/service";
import { createCardStore, MIGRATIONS } from "./lib/store";

export { rpcContract } from "./lib/contract";
export type { Card, CardAttachment, CardHistory } from "./lib/store";

const CARDS_CHANGED = "cards:changed";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    providerId: {
      type: "string",
      label: "Provider",
      default: "claude-code",
    },
    model: {
      type: "string",
      label: "Model",
      default: "claude-fable-5-1",
    },
    reasoningLevel: {
      type: "select",
      label: "Reasoning",
      options: ["low", "medium", "high", "xhigh", "max"],
      default: "high",
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
  const capacity = createPipelineCapacity(bb, store);
  bb.experimental_hooks.on("message.dispatch", capacity.decide, { experimental_enforcement: "strict" });
  const service = createPipelineService({
    store,
    sdk: bb.sdk,
    getSettings: () => settings.get(),
    readIssue,
    classify: (input) =>
      askJev({
        ...input,
        log: (message) => bb.log.info(message),
      }),
    log: (message) => bb.log.warn(message),
    publish: (projectId) => bb.realtime.publish(CARDS_CHANGED, { projectId }),
  });

  bb.rpc.register(rpcContract, {
    async listProjects() {
      const projects = await bb.sdk.projects.list();
      return { projects: projects.map(({ id, name }) => ({ id, name })) };
    },
    async listCards({ projectId, includeDone }) {
      return {
        cards: store.list(projectId, includeDone),
        queuedCardIds: await capacity.queuedCardIds(projectId),
      };
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
    moveCard({ cardId, column }) {
      return service.move(cardId, column, "ui");
    },
    retryLaunch({ cardId }) {
      return service.retry(cardId);
    },
    removeCard({ cardId }) {
      return { removed: service.remove(cardId) };
    },
    async showCard({ cardId }) {
      const card = store.get(cardId);
      if (card === null) throw new Error(`unknown card ${cardId}`);
      const queued = (await capacity.queuedCardIds(card.projectId)).includes(cardId);
      return { card, history: store.history(cardId), queued };
    },
  });

  bb.cli.register(createPipelineCli({ service, store, sdk: bb.sdk, capacity }));

  for (const event of ["thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      await bb.experimental_hooks.recheck("message.dispatch");
      await capacity.publish(thread);
    });
  }
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (thread.status === "active" || thread.status === "starting") return;
    await bb.experimental_hooks.recheck("message.dispatch");
    await capacity.publish(thread);
  });
  for (const event of ["message.queued", "message.dispatched", "message.cancelled"] as const) {
    bb.events.on(event, async ({ entry }) => {
      const thread = await bb.sdk.threads.get({ threadId: entry.threadId, experimental_includeDeleted: true });
      if (event !== "message.dispatched") await service.onThreadQueueChanged(thread);
      await capacity.publish(thread);
    });
  }

  bb.events.on("thread.active", ({ thread }) => service.onThreadActive(thread));
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
      await bb.experimental_hooks.recheck("message.dispatch");
      await service.startupPass();
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
}
