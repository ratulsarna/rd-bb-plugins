import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { ExecutionDefaults } from "../lib/execution";
import {
  createPipelineService,
  type PipelineSettings,
} from "../lib/service";
import {
  createCardStore,
  MIGRATIONS,
  type CardAttachment,
} from "../lib/store";
import { ownerThread } from "../lib/card";
import type { Database } from "better-sqlite3";
import {
  makeCatalogProvider,
  makeCheckoutEnvironment,
  testCatalogProviders,
  testProviderModels,
  type TestProviderListInput,
  type TestProviderListResult,
  type TestProviderModelsInput,
  type TestProviderModelsResult,
  type TestEnvironment,
  type TestEnvironmentListInput,
} from "./sdk-fake";

const settings: PipelineSettings = {
  providerId: "claude-code",
  model: "claude-fable-5-1",
  reasoningLevel: "high",
  permissionMode: "full",
  jevApiKey: "jev-key",
  jevThreshold: "0.7",
};

const projectSource = {
  id: "source_1",
  projectId: "proj_1",
  type: "local_path",
  hostId: "host_mac",
  path: "/repo",
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
};

const project = {
  id: "proj_1",
  kind: "standard",
  name: "Example",
  gitRemoteUrl: "https://github.com/example/repo",
  createdAt: 1,
  updatedAt: 1,
  sources: [projectSource],
};

const twoMachineProject = {
  ...project,
  sources: [
    projectSource,
    {
      id: "source_2",
      projectId: "proj_1",
      type: "local_path",
      hostId: "host_linux",
      path: "/repo-linux",
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

const hostList = [
  makeHostResponse({ id: "host_mac", name: "Mac", status: "connected" }),
  makeHostResponse({
    id: "host_linux",
    name: "Linux box",
    status: "disconnected",
  }),
];

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
type ThreadListInput = NonNullable<
  Parameters<PluginBbSdk["threads"]["list"]>[0]
>;
type ThreadListResult = Awaited<ReturnType<PluginBbSdk["threads"]["list"]>>;
type ThreadMetadataResult = Awaited<
  ReturnType<PluginBbSdk["threads"]["getPluginMetadata"]>
>;

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function setup(options?: {
  spawn?: (request: unknown) => Promise<ReturnType<typeof makeThreadResponse>>;
  send?: (request: unknown) => Promise<{ ok: true; delivery: "sent" }>;
  getThread?: (input: { threadId: string }) => Promise<ReturnType<typeof makeThreadResponse>>;
  getThreadOutput?: (input: { threadId: string }) => Promise<{ output: string }>;
  listThreads?: (input: ThreadListInput) => Promise<ThreadListResult>;
  getThreadMetadata?: (input: { threadId: string }) => Promise<ThreadMetadataResult>;
  listEnvironments?: (input: TestEnvironmentListInput) => Promise<TestEnvironment[]>;
  project?: typeof project;
  hosts?: typeof hostList;
  readIssue?: (url: string) => Promise<{ title: string; body: string; labels: string[] }>;
  classify?: (input: unknown) => Promise<{ decision: "needs" | "no" | "unknown"; probability: number | null }>;
  settings?: PipelineSettings;
  getSettings?: () => Promise<PipelineSettings>;
  rememberExecution?: (defaults: ExecutionDefaults) => Promise<void>;
  listProviders?: (input: TestProviderListInput) => Promise<TestProviderListResult>;
  listProviderModels?: (input: TestProviderModelsInput) => Promise<TestProviderModelsResult>;
}) {
  let nextThread = 1;
  const spawn = vi.fn(
    options?.spawn ??
      (async () => makeThreadResponse({ id: `thr_${nextThread++}` })),
  );
  const send = vi.fn(
    options?.send ?? (async () => ({ ok: true as const, delivery: "sent" as const })),
  );
  const listProviders = vi.fn(
    options?.listProviders ?? (async () => testCatalogProviders),
  );
  const listEnvironments = vi.fn(options?.listEnvironments ?? (async (input: TestEnvironmentListInput) => [
    makeCheckoutEnvironment({ projectId: input.projectId, hostId: input.hostId, path: input.path }),
  ]));
  const listProviderModels = vi.fn(
    options?.listProviderModels ??
      (async ({ providerId }: TestProviderModelsInput) =>
        testProviderModels(providerId)),
  );
  const host = createFakePluginHost({
    pluginId: "pipeline",
    sdk: {
      projects: {
        get: async () => (options?.project ?? project) as never,
      },
      hosts: {
        list: async () => (options?.hosts ?? hostList) as never,
      },
      environments: { list: listEnvironments as never },
      providers: {
        list: listProviders as never,
        models: listProviderModels as never,
      },
      threads: {
        spawn: spawn as never,
        send: send as never,
        ...(options?.getThread === undefined
          ? {}
          : { get: options.getThread as never }),
        ...(options?.getThreadOutput === undefined
          ? {}
          : { output: options.getThreadOutput as never }),
        ...(options?.listThreads === undefined
          ? {}
          : { list: options.listThreads as never }),
        ...(options?.getThreadMetadata === undefined
          ? {}
          : { getPluginMetadata: options.getThreadMetadata as never }),
      },
    },
  });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db, (() => {
    let now = 100;
    return () => now++;
  })());
  const classify = vi.fn(
    options?.classify ??
      (async () => ({ decision: "no" as const, probability: 0.1 })),
  );
  const readIssue = vi.fn(
    options?.readIssue ??
      (async () => ({ title: "Issue", body: "Details", labels: [] })),
  );
  const publish = vi.fn();
  const onAttention = vi.fn();
  const log = vi.fn();
  const rememberExecution = vi.fn(options?.rememberExecution ?? (async () => {}));
  const service = createPipelineService({
    store,
    sdk: host.bb.sdk as PluginBbSdk,
    getSettings: options?.getSettings ?? (async () => options?.settings ?? settings),
    rememberExecution,
    readIssue,
    classify,
    log,
    publish,
    onAttention,
    id: () => "card_new",
  });
  return { host, db: host.bb.storage.database(), store, service, spawn, send, classify, readIssue, publish, onAttention, log, rememberExecution, listProviders, listProviderModels, listEnvironments };
}

function seed(
  store: ReturnType<typeof setup>["store"],
  options?: {
    id?: string;
    hostId?: string;
    attachments?: CardAttachment[];
    intake?: ExecutionDefaults["intake"];
    lead?: ExecutionDefaults["lead"];
  },
) {
  return store.create({
    id: options?.id ?? "card_1",
    projectId: "proj_1",
    hostId: options?.hostId ?? "host_mac",
    intake: options?.intake,
    lead: options?.lead,
    title: "Build it",
    body: "Body",
    attachments: options?.attachments ?? [],
    source: "cli",
  });
}

/** A row from before machines were mandatory: no host_id. */
function seedLegacyRow(db: Database, id = "card_legacy"): void {
  db.prepare(
    `INSERT INTO cards (id, project_id, title, "column", created_at, updated_at)
     VALUES (?, 'proj_1', 'Legacy card', 'backlog', 100, 100)`,
  ).run(id);
}

function thread(
  id: string,
  activeBackgroundAgentCount = 0,
  overrides: Partial<ReturnType<typeof makeThreadResponse>> = {},
) {
  return makeThreadResponse({ id, activeBackgroundAgentCount, ...overrides });
}

function listedThread(id: string): ThreadListResult[number] {
  return makeThreadResponse({ id }) as unknown as ThreadListResult[number];
}

describe("idle policy", () => {
  it("notifies once per attention episode across reports, idle updates, and startup", async () => {
    const { store, service, onAttention } = setup({
      getThread: async ({ threadId }) => thread(threadId),
      getThreadOutput: async () => ({ output: "Ready for you" }),
    });
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });
    await service.report({ cardId: "card_1", needsYou: "Approve the scope" });
    await service.report({ cardId: "card_1", needsYou: "Approve the scope" });
    await service.onThreadIdle(thread("intake"), "Ready for you");
    await service.startupPass();
    expect(onAttention).toHaveBeenCalledOnce();
    expect(onAttention).toHaveBeenCalledWith(
      expect.objectContaining({ id: "card_1", needsUser: true }), "Approve the scope", "questions",
    );

    await service.onThreadActive(thread("intake", 0, { status: "active" }));
    await service.onThreadIdle(thread("intake"), "Another question");
    expect(onAttention).toHaveBeenCalledTimes(2);
    expect(onAttention.mock.calls[1]![1]).toBe("intake is waiting for you");
    await service.onThreadIdle(thread("unrelated"), "Ignore me");
    store.update("card_1", { ownerRole: "lead", leadThreadId: "lead", needsUser: false });
    await service.onThreadIdle(thread("intake"), "Old intake");
    expect(onAttention).toHaveBeenCalledTimes(2);
  });

  it("notifies launch failure once, then rearms after recovery", async () => {
    let offline = true;
    const { store, service, onAttention } = setup({
      spawn: async () => {
        if (offline) throw new Error("machine offline");
        return thread("intake");
      },
    });
    seed(store);
    await service.launch("card_1", "intake");
    await service.retry("card_1");
    expect(onAttention).toHaveBeenCalledOnce();
    expect(onAttention.mock.calls[0]![1]).toBe("Launch failed: intake: machine offline");
    expect(onAttention.mock.calls[0]![2]).toBe("failures");
    offline = false;
    await service.retry("card_1");
    await service.onThreadFailed(thread("intake", 0, { status: "error" }), "provider stopped");
    await service.onThreadFailed(thread("intake", 0, { status: "error" }), "provider stopped");
    expect(onAttention).toHaveBeenCalledTimes(2);
    expect(onAttention.mock.calls[1]![2]).toBe("failures");
  });

  it("moves the first intake idle to todo and asks for the user", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });

    await service.onThreadIdle(thread("intake"), "What is this about?");

    expect(store.get("card_1")).toMatchObject({
      column: "todo",
      needsUser: true,
      attentionReason: "intake is waiting for you",
    });
  });

  it("ignores intake idle after the lead owns the card", async () => {
    const { store, service } = setup();
    seed(store);
    const before = store.update("card_1", {
      intakeThreadId: "intake",
      leadThreadId: "lead",
      ownerRole: "lead",
    });

    await service.onThreadIdle(thread("intake"), "Question?");

    expect(store.get("card_1")).toEqual(before);
    expect(store.history("card_1").at(-1)?.note).toBe("ignored non-owner idle");
  });

  it("does nothing while lead children are active", async () => {
    const { store, service, classify } = setup();
    seed(store);
    const before = store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    await service.onThreadIdle(thread("lead", 1), "Question?");

    expect(store.get("card_1")).toEqual(before);
    expect(classify).not.toHaveBeenCalled();
  });

  it("does nothing while intake children are active", async () => {
    const { store, service } = setup();
    seed(store);
    const before = store.update("card_1", { intakeThreadId: "intake" });

    await service.onThreadIdle(thread("intake", 1), "Question?");

    expect(store.get("card_1")).toEqual(before);
  });

  it("trusts an explicit needs-you report for the turn", async () => {
    const { store, service, classify } = setup();
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });
    await service.report({ threadId: "lead", needsYou: "Choose one" });
    const before = store.get("card_1");

    await service.onThreadIdle(thread("lead"), "Choose one?");

    expect(store.get("card_1")).toEqual(before);
    expect(classify).not.toHaveBeenCalled();
  });

  it("checks Jev after an earlier working report", async () => {
    const { store, service, classify } = setup({
      classify: async () => ({ decision: "needs", probability: 0.9 }),
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });
    await service.report({ threadId: "lead", working: true });

    await service.onThreadIdle(thread("lead"), "Pick A or B?");

    expect(classify).toHaveBeenCalledOnce();
    expect(store.get("card_1")?.needsUser).toBe(true);
  });

  it.each([null, "", "   "])("treats blank text %p as unknown without Jev", async (text) => {
    const { store, service, classify } = setup({
      classify: async () => ({ decision: "unknown", probability: null }),
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    await service.onThreadIdle(thread("lead"), text);

    expect(classify).toHaveBeenCalledOnce();
    expect(store.get("card_1")).toMatchObject({ needsUser: false, attentionUnknown: true });
  });

  it.each([
    ["needs", true, false],
    ["no", false, false],
    ["unknown", false, true],
  ] as const)("maps Jev %s to attention state", async (decision, needsUser, unknown) => {
    const { store, service, onAttention } = setup({
      classify: async () => ({ decision, probability: decision === "needs" ? 0.9 : decision === "no" ? 0.1 : 0.5 }),
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });
    const message = `status ${"x".repeat(220)} question`;

    await service.onThreadIdle(thread("lead"), message);

    expect(store.get("card_1")).toMatchObject({ needsUser, attentionUnknown: unknown });
    expect(onAttention).toHaveBeenCalledTimes(needsUser ? 1 : 0);
    if (decision === "needs") expect(store.get("card_1")?.attentionReason).toBe(message.slice(-200));
  });

  it.each(["needs", "no", "unknown"] as const)(
    "does not rewrite an unchanged %s lead idle state",
    async (decision) => {
      const { store, service, publish } = setup({
        classify: async () => ({ decision, probability: 0.9 }),
      });
      seed(store);
      store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });
      await service.onThreadIdle(thread("lead"), "Same result");
      const before = store.get("card_1");
      const historyLength = store.history("card_1").length;
      publish.mockClear();

      await service.onThreadIdle(thread("lead"), "Same result");

      expect(store.get("card_1")).toEqual(before);
      expect(store.history("card_1")).toHaveLength(historyLength);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("discards a Jev answer overtaken by another mutation", async () => {
    let resolve!: (value: { decision: "needs"; probability: number }) => void;
    const pending = new Promise<{ decision: "needs"; probability: number }>((done) => { resolve = done; });
    const { store, service } = setup({ classify: async () => pending });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    const idle = service.onThreadIdle(thread("lead"), "Need a decision?");
    await vi.waitFor(() => expect(store.get("card_1")?.revision).toBe(1));
    store.update("card_1", { prUrl: "https://example.com/pr/1" });
    resolve({ decision: "needs", probability: 0.9 });
    await idle;

    expect(store.get("card_1")).toMatchObject({ needsUser: false, prUrl: "https://example.com/pr/1" });
  });

  it("shows unknown without a Jev key", async () => {
    const { store, service, classify } = setup({
      classify: async () => ({ decision: "unknown", probability: null }),
      settings: { ...settings, jevApiKey: undefined },
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    await service.onThreadIdle(thread("lead"), "Question?");

    expect(classify).toHaveBeenCalledWith({
      apiKey: undefined,
      threshold: 0.7,
      lastText: "Question?",
    });
    expect(store.get("card_1")).toMatchObject({ needsUser: false, attentionUnknown: true });
  });

  it("preserves an explicit intake needs-you reason on idle", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });
    await service.report({ threadId: "intake", needsYou: "Which repository?" });

    await service.onThreadIdle(thread("intake"), "Which repository?");

    expect(store.get("card_1")).toMatchObject({
      column: "todo",
      needsUser: true,
      attentionReason: "Which repository?",
      reportSignal: "needs_you",
    });
  });
});

describe("owner rules", () => {
  it("records intake failure after lead handoff without changing attention", async () => {
    const { store, service } = setup();
    seed(store);
    const before = store.update("card_1", {
      intakeThreadId: "intake",
      leadThreadId: "lead",
      ownerRole: "lead",
    });

    await service.onThreadFailed(thread("intake", 0, { status: "error" }), "old failure");

    expect(store.get("card_1")).toEqual(before);
    expect(store.history("card_1").at(-1)).toMatchObject({ kind: "thread_failed", threadId: "intake" });
  });

  it("marks a lead failure as needing the user", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    await service.onThreadFailed(thread("lead", 0, { status: "error" }), "boom");

    expect(store.get("card_1")).toMatchObject({ needsUser: true, attentionReason: "thread failed: boom" });
  });

  it("allows unrelated explicit-card reports to hand off planning", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });

    await service.report({
      cardId: "card_1",
      threadId: "unrelated",
      column: "planning",
      issueUrl: "https://github.com/o/r/issues/2",
      working: true,
    });

    expect(store.get("card_1")).toMatchObject({
      column: "planning",
      ownerRole: "lead",
      leadThreadId: "thr_1",
      issueUrl: "https://github.com/o/r/issues/2",
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(store.history("card_1")).toContainEqual(
      expect.objectContaining({ kind: "attention", threadId: "unrelated" }),
    );
  });

  it("rejects reports from a former owner resolving by thread", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", {
      intakeThreadId: "intake",
      leadThreadId: "lead",
      ownerRole: "lead",
      issueUrl: "https://github.com/o/r/issues/2",
    });

    await expect(
      service.report({
        threadId: "intake",
        issueUrl: "https://github.com/o/r/issues/3",
        working: true,
      }),
    ).rejects.toThrow("now led by lead");
    expect(store.get("card_1")?.issueUrl).toBe("https://github.com/o/r/issues/2");
  });

  it("reconciles an unarchived idle lead from its current state", async () => {
    const { store, service } = setup({
      classify: async () => ({ decision: "unknown", probability: null }),
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });
    await service.onThreadGone(thread("lead", 0, { archivedAt: 1 }));

    await service.onThreadUnarchived(
      makeThreadResponse({ id: "lead", status: "idle", archivedAt: null }),
    );

    expect(store.get("card_1")).toMatchObject({
      needsUser: false,
      attentionReason: null,
      attentionUnknown: true,
    });
  });
});

describe("launch", () => {
  it("keeps lead ownership after a card enters planning", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", { issueUrl: "https://github.com/o/r/issues/1" });

    await service.move("card_1", "planning", "ui");
    expect(store.get("card_1")).toMatchObject({ ownerRole: "lead" });

    await service.move("card_1", "todo", "ui");
    expect(store.get("card_1")).toMatchObject({ ownerRole: "lead" });
  });

  it("rejects a planning move without an issue and accepts the later intake handoff", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    const before = store.update("card_1", { intakeThreadId: "intake" });

    await expect(service.move("card_1", "planning", "ui")).rejects.toThrow(
      "no issue yet: let intake finish, or pass --issue <url>",
    );

    expect(store.get("card_1")).toEqual(before);
    expect(ownerThread(store.get("card_1")!)).toBe("intake");
    expect(spawn).not.toHaveBeenCalled();

    await service.report({
      threadId: "intake",
      column: "planning",
      issueUrl: "https://github.com/o/r/issues/1",
      working: true,
    });
    expect(store.get("card_1")).toMatchObject({
      column: "planning",
      ownerRole: "lead",
      leadThreadId: "thr_1",
    });
  });

  it("launches once when the handoff report supplies the issue", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });

    await service.report({
      threadId: "intake",
      column: "planning",
      issueUrl: "  https://github.com/o/r/issues/1  ",
      working: true,
    });

    expect(store.get("card_1")).toMatchObject({
      column: "planning",
      ownerRole: "lead",
      leadThreadId: "thr_1",
      issueUrl: "https://github.com/o/r/issues/1",
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("rejects a planning report without an issue before changing the card", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    const before = store.update("card_1", { intakeThreadId: "intake" });

    await expect(
      service.report({
        threadId: "intake",
        column: "planning",
        working: true,
      }),
    ).rejects.toThrow(
      "no issue yet: let intake finish, or pass --issue <url>",
    );

    expect(store.get("card_1")).toEqual(before);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty", issueUrl: "" },
    { label: "whitespace-only", issueUrl: "  \t " },
  ])(
    "rejects a $label issue before a planning handoff",
    async ({ issueUrl }) => {
      const { store, service, spawn, readIssue } = setup();
      seed(store);
      const before = store.update("card_1", { intakeThreadId: "intake" });

      await expect(
        service.report({
          threadId: "intake",
          column: "planning",
          issueUrl,
          working: true,
        }),
      ).rejects.toThrow(
        "no issue yet: let intake finish, or pass --issue <url>",
      );

      expect(store.get("card_1")).toEqual(before);
      expect(readIssue).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("is idempotent for repeated planning reports", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    store.update("card_1", { intakeThreadId: "intake", issueUrl: "https://github.com/o/r/issues/1" });

    await service.report({ cardId: "card_1", column: "planning" });
    await service.report({ cardId: "card_1", column: "planning" });

    expect(spawn).toHaveBeenCalledOnce();
  });

  it("serializes concurrent planning launches", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    store.update("card_1", { issueUrl: "https://github.com/o/r/issues/1" });

    await Promise.all([
      service.move("card_1", "planning", "ui"),
      service.move("card_1", "planning", "cli"),
    ]);

    expect(spawn).toHaveBeenCalledOnce();
  });

  it("does not spawn a second intake thread", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });

    await service.launch("card_1", "intake");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn when a card is held during async launch preparation", async () => {
    let finishPreparation!: (value: PipelineSettings) => void;
    const preparing = new Promise<PipelineSettings>((resolve) => {
      finishPreparation = resolve;
    });
    const getSettings = vi.fn(async () => preparing);
    const { store, service, spawn } = setup({ getSettings });
    seed(store);

    const launching = service.launch("card_1", "intake");
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledOnce());
    const held = store.update("card_1", { runState: "pause_requested" });
    finishPreparation(settings);

    await expect(launching).resolves.toEqual(held);
    expect(spawn).not.toHaveBeenCalled();
    expect(store.get("card_1")).toEqual(held);
  });

  it("does not spawn after ownership or thread linkage changes during preparation", async () => {
    let finishPreparation!: (value: PipelineSettings) => void;
    const preparing = new Promise<PipelineSettings>((resolve) => {
      finishPreparation = resolve;
    });
    const getSettings = vi.fn(async () => preparing);
    const { store, service, spawn } = setup({ getSettings });
    seed(store);

    const launching = service.launch("card_1", "intake");
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledOnce());
    const handedOff = store.update("card_1", {
      ownerRole: "lead",
      leadThreadId: "lead",
    });
    finishPreparation(settings);

    await expect(launching).resolves.toEqual(handedOff);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("links a spawn already in flight when the card becomes held", async () => {
    let finishSpawn!: () => void;
    const spawning = new Promise<void>((resolve) => {
      finishSpawn = resolve;
    });
    const { store, service, spawn } = setup({
      spawn: async () => {
        await spawning;
        return thread("intake");
      },
    });
    seed(store);

    const launching = service.launch("card_1", "intake");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    store.update("card_1", { runState: "pausing" });
    finishSpawn();

    await expect(launching).resolves.toMatchObject({
      runState: "pausing",
      intakeThreadId: "intake",
    });
  });

  it("records a spawn error and retries exactly once", async () => {
    let fail = true;
    const { store, service, spawn } = setup({
      spawn: async () => {
        if (fail) throw new Error("Mac offline");
        return makeThreadResponse({ id: "intake" });
      },
    });
    seed(store);

    await service.launch("card_1", "intake");
    expect(store.get("card_1")?.launchError).toContain("Mac offline");
    fail = false;
    await service.retry("card_1");

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(store.get("card_1")).toMatchObject({ intakeThreadId: "intake", launchError: null });
  });

  it("retries the lead after a failed planning launch", async () => {
    let offline = true;
    const { store, service, spawn } = setup({
      spawn: async () => {
        if (offline) throw new Error("Mac offline");
        return makeThreadResponse({ id: "lead-retry" });
      },
    });
    seed(store);
    store.update("card_1", {
      intakeThreadId: "intake",
      issueUrl: "https://github.com/o/r/issues/1",
    });

    await service.move("card_1", "planning", "ui");
    expect(store.get("card_1")?.launchError).toContain("lead: Mac offline");

    offline = false;
    await service.retry("card_1");

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(store.get("card_1")).toMatchObject({
      intakeThreadId: "intake",
      leadThreadId: "lead-retry",
      launchError: null,
    });
  });

  it("relaunches a deleted lead on retry", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    store.update("card_1", {
      intakeThreadId: "intake",
      leadThreadId: "deleted-lead",
      ownerRole: "lead",
      issueUrl: "https://github.com/o/r/issues/1",
    });

    await service.onThreadGone(thread("deleted-lead", 0, { deletedAt: 1 }));
    expect(store.get("card_1")).toMatchObject({
      leadThreadId: null,
      launchError: "lead: thread deleted",
      needsUser: true,
      attentionReason: "thread deleted",
    });

    await service.retry("card_1");

    expect(spawn).toHaveBeenCalledOnce();
    expect(store.get("card_1")).toMatchObject({
      leadThreadId: "thr_1",
      launchError: null,
    });
  });

  it("keeps lead ownership while a deleted lead is absent", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    store.update("card_1", {
      intakeThreadId: "intake",
      leadThreadId: "deleted-lead",
      ownerRole: "lead",
      issueUrl: "https://github.com/o/r/issues/1",
    });

    await service.onThreadGone(thread("deleted-lead", 0, { deletedAt: 1 }));
    const deleted = store.get("card_1")!;
    expect(ownerThread(deleted)).toBeNull();

    await service.onThreadIdle(thread("intake"), "Old intake question");
    expect(store.get("card_1")).toEqual(deleted);

    await service.retry("card_1");
    expect(spawn).toHaveBeenCalledOnce();
    expect(ownerThread(store.get("card_1")!)).toBe("thr_1");
  });

  it("clears lifecycle attention after a successful launch", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", {
      needsUser: true,
      attentionReason: "thread deleted",
      attentionSource: "system",
      attentionUnknown: true,
      reportSignal: "needs_you",
      threadError: "gone",
      launchError: "intake: thread deleted",
    });

    await service.retry("card_1");

    expect(store.get("card_1")).toMatchObject({
      needsUser: false,
      attentionReason: null,
      attentionSource: null,
      attentionUnknown: false,
      reportSignal: null,
      threadError: null,
      launchError: null,
    });
  });

  it("rejects retry without a launch error", async () => {
    const { store, service } = setup();
    seed(store);
    await expect(service.retry("card_1")).rejects.toThrow("nothing to retry");
  });

  it("records a missing checkout as a launch error", async () => {
    const { store, service, spawn } = setup({ project: { ...project, sources: [] } });
    seed(store);

    await service.launch("card_1", "intake");

    expect(store.get("card_1")?.launchError).toContain("project has no checkout on host_mac");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("records issue read failure with the URL", async () => {
    const url = "https://github.com/o/r/issues/7";
    const { store, service, spawn } = setup({ readIssue: async () => { throw new Error(`could not read ${url}: denied`); } });
    seed(store);
    store.update("card_1", { issueUrl: url });

    await service.launch("card_1", "lead");

    expect(store.get("card_1")?.launchError).toContain(url);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("requires an issue before a direct lead launch", async () => {
    const { store, service, spawn } = setup();
    seed(store);

    await service.launch("card_1", "lead");

    expect(store.get("card_1")?.launchError).toContain(
      "no issue yet: let intake finish, or pass --issue <url>",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("attaches the user's files to intake and lead", async () => {
    const attachments: CardAttachment[] = [
      { path: "attachments/screenshot.png", filename: "screenshot.png", mimeType: "image/png", sizeBytes: 10, isImage: true },
      { path: "attachments/notes.txt", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 12, isImage: false },
    ];
    const { store, service, spawn } = setup();
    seed(store, { attachments });
    await service.launch("card_1", "intake");
    store.update("card_1", { issueUrl: "https://github.com/o/r/issues/1" });
    await service.launch("card_1", "lead");

    for (const [request] of spawn.mock.calls) {
      expect((request as { input: unknown[] }).input).toEqual(expect.arrayContaining([
        { type: "localImage", path: "attachments/screenshot.png" },
        { type: "localFile", path: "attachments/notes.txt", name: "notes.txt", mimeType: "text/plain", sizeBytes: 12 },
      ]));
    }
  });

  it("re-sends cancelled intake and lead kickoffs on their existing threads", async () => {
    const attachments: CardAttachment[] = [
      { path: "attachments/screenshot.png", filename: "screenshot.png", isImage: true },
      { path: "attachments/notes.txt", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 12, isImage: false },
    ];

    for (const role of ["intake", "lead"] as const) {
      const { store, service, spawn, send } = setup({
        getThread: async ({ threadId }) =>
          thread(threadId, 0, { status: "pending", queuedMessageCount: 0 }),
      });
      const cardId = `card_${role}`;
      seed(store, { id: cardId, attachments });
      if (role === "lead") {
        store.update(cardId, {
          issueUrl: "https://github.com/o/r/issues/1",
          ownerRole: "lead",
        });
      }
      await service.launch(cardId, role);
      const launched = store.get(cardId)!;
      const threadId = role === "intake"
        ? launched.intakeThreadId!
        : launched.leadThreadId!;
      const originalInput = (spawn.mock.calls[0]![0] as { input: unknown[] }).input;

      await service.onThreadQueueChanged(
        thread(threadId, 0, { status: "pending", queuedMessageCount: 0 }),
      );

      expect(store.get(cardId)).toMatchObject({
        hostId: "host_mac",
        ownerRole: role,
        needsUser: true,
        attentionReason: `${role} start cancelled`,
        launchError: `${role}: start cancelled`,
      });

      await service.retry(cardId);

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({
        threadId,
        mode: "auto",
        input: originalInput,
        model: "claude-fable-5-1",
        reasoningLevel: "high",
        permissionMode: "full",
      });
      expect(spawn).toHaveBeenCalledOnce();
      expect(store.get(cardId)).toMatchObject({
        hostId: "host_mac",
        ownerRole: role,
        intakeThreadId: launched.intakeThreadId,
        leadThreadId: launched.leadThreadId,
        needsUser: false,
        attentionReason: null,
        launchError: null,
      });
    }
  });

  it("serializes concurrent retries of a cancelled start into one send", async () => {
    let finishSend!: () => void;
    const sending = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const { store, service, send } = setup({
      getThread: async ({ threadId }) =>
        thread(threadId, 0, { status: "pending", queuedMessageCount: 0 }),
      send: async () => {
        await sending;
        return { ok: true, delivery: "sent" };
      },
    });
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });
    await service.onThreadQueueChanged(
      thread("intake", 0, { status: "pending", queuedMessageCount: 0 }),
    );

    const first = service.retry("card_1");
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const second = service.retry("card_1");
    finishSend();
    await Promise.all([first, second]);

    expect(send).toHaveBeenCalledOnce();
    expect(store.get("card_1")?.launchError).toBeNull();
  });

  it("reconciles work queued before retry instead of duplicating the kickoff", async () => {
    const { store, service, send } = setup({
      getThread: async ({ threadId }) =>
        thread(threadId, 0, { status: "pending", queuedMessageCount: 1 }),
    });
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });
    await service.onThreadQueueChanged(
      thread("intake", 0, { status: "pending", queuedMessageCount: 0 }),
    );

    const retried = await service.retry("card_1");

    expect(send).not.toHaveBeenCalled();
    expect(retried).toMatchObject({
      intakeThreadId: "intake",
      needsUser: false,
      attentionReason: null,
      launchError: null,
    });
  });

  it("only treats an owning pending thread with an empty queue as cancelled", async () => {
    const { store, service } = setup();
    seed(store);
    const owned = store.update("card_1", {
      intakeThreadId: "intake",
      leadThreadId: "lead",
      ownerRole: "lead",
    });

    await service.onThreadQueueChanged(
      thread("intake", 0, { status: "pending", queuedMessageCount: 0 }),
    );
    expect(store.get("card_1")).toEqual(owned);

    await service.onThreadQueueChanged(
      thread("lead", 0, { status: "pending", queuedMessageCount: 1 }),
    );
    const followUpAttention = store.update("card_1", {
      needsUser: true,
      attentionReason: "Choose a release target",
      attentionSource: "report",
      reportSignal: "needs_you",
    });
    await service.onThreadQueueChanged(
      thread("lead", 0, { status: "idle", queuedMessageCount: 0 }),
    );
    await service.onThreadQueueChanged(
      thread("lead", 0, { status: "active", queuedMessageCount: 0 }),
    );
    expect(store.get("card_1")).toEqual(followUpAttention);

    await service.onThreadQueueChanged(
      thread("lead", 0, { status: "pending", queuedMessageCount: 0 }),
    );
    expect(store.get("card_1")?.launchError).toBe("lead: start cancelled");

    await service.onThreadQueueChanged(
      thread("lead", 0, { status: "pending", queuedMessageCount: 1 }),
    );
    expect(store.get("card_1")).toMatchObject({
      leadThreadId: "lead",
      ownerRole: "lead",
      needsUser: false,
      launchError: null,
    });
  });
});

describe("held cards", () => {
  it("rejects launch, retry, move, removal, and owner handoff until resume", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    const held = store.update("card_1", {
      runState: "paused",
      launchError: "intake: start cancelled",
    });

    await expect(service.launch("card_1", "intake")).rejects.toThrow(
      "resume it before launching it",
    );
    await expect(service.retry("card_1")).rejects.toThrow(
      "resume it before retrying it",
    );
    await expect(service.move("card_1", "todo", "ui")).rejects.toThrow(
      "resume it before moving it",
    );
    expect(() => service.remove("card_1")).toThrow(
      "resume it before removing it",
    );
    await expect(
      service.report({
        cardId: "card_1",
        column: "planning",
        issueUrl: "https://github.com/o/r/issues/1",
      }),
    ).rejects.toThrow("resume it before changing its phase or owner");

    expect(store.get("card_1")).toEqual(held);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts metadata and attention reports without moving or launching", async () => {
    const { store, service, spawn } = setup();
    seed(store);
    store.update("card_1", {
      runState: "pausing",
      intakeThreadId: "intake",
    });

    const reported = await service.report({
      threadId: "intake",
      issueUrl: "https://github.com/o/r/issues/2",
      prUrl: "https://github.com/o/r/pull/3",
      tier: "small",
      needsYou: "Keep this context for resume",
    });

    expect(reported).toMatchObject({
      runState: "pausing",
      column: "backlog",
      ownerRole: "intake",
      intakeThreadId: "intake",
      issueUrl: "https://github.com/o/r/issues/2",
      prUrl: "https://github.com/o/r/pull/3",
      tier: "small",
      needsUser: true,
      attentionReason: "Keep this context for resume",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("ignores held idle and cancelled-queue observations, then reconciles after resume", async () => {
    const { store, service, classify, onAttention } = setup({
      getThread: async ({ threadId }) =>
        thread(threadId, 0, { status: "pending", queuedMessageCount: 0 }),
    });
    seed(store);
    const held = store.update("card_1", {
      runState: "paused",
      intakeThreadId: "intake",
    });

    await service.onThreadIdle(thread("intake"), "Question while paused?");
    await service.onThreadQueueChanged(
      thread("intake", 0, { status: "pending", queuedMessageCount: 0 }),
    );
    await service.startupPass();

    expect(store.get("card_1")).toEqual(held);
    expect(classify).not.toHaveBeenCalled();
    expect(onAttention).not.toHaveBeenCalled();

    store.update("card_1", { runState: "running" });
    await service.onThreadQueueChanged(
      thread("intake", 0, { status: "pending", queuedMessageCount: 0 }),
    );
    expect(store.get("card_1")).toMatchObject({
      runState: "running",
      launchError: "intake: start cancelled",
      attentionReason: "intake start cancelled",
    });
  });

  it("drops a deleted owner link so resume can use the normal launch path", async () => {
    const { store, service, spawn, onAttention } = setup();
    seed(store);
    store.update("card_1", {
      runState: "paused",
      intakeThreadId: "deleted-intake",
    });

    await service.onThreadGone(
      thread("deleted-intake", 0, { deletedAt: 1 }),
    );

    expect(store.get("card_1")).toMatchObject({
      runState: "paused",
      intakeThreadId: null,
      launchError: null,
      needsUser: false,
    });
    expect(onAttention).not.toHaveBeenCalled();

    store.update("card_1", { runState: "running" });
    await service.launch("card_1", "intake");

    expect(spawn).toHaveBeenCalledOnce();
    expect(store.get("card_1")).toMatchObject({
      runState: "running",
      intakeThreadId: "thr_1",
    });
  });
});

describe("startup pass", () => {
  it("recovers a missed cancelled-start event", async () => {
    const { store, service } = setup({
      getThread: async ({ threadId }) =>
        thread(threadId, 0, { status: "pending", queuedMessageCount: 0 }),
    });
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });

    await service.startupPass();

    expect(store.get("card_1")).toMatchObject({
      intakeThreadId: "intake",
      needsUser: true,
      attentionReason: "intake start cancelled",
      launchError: "intake: start cancelled",
    });
  });

  it("discards an idle observation overtaken by an active event", async () => {
    let resolveOutput!: (value: { output: string }) => void;
    const output = new Promise<{ output: string }>((resolve) => {
      resolveOutput = resolve;
    });
    const getThreadOutput = vi.fn(async () => output);
    const { store, service } = setup({
      getThread: async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      getThreadOutput,
    });
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });
    await service.report({ threadId: "intake", needsYou: "Choose a target" });

    const startup = service.startupPass();
    await vi.waitFor(() => expect(getThreadOutput).toHaveBeenCalledOnce());
    await service.onThreadActive(thread("intake", 0, { status: "active" }));
    const afterActive = store.get("card_1");
    resolveOutput({ output: "Stale idle question" });
    await startup;

    expect(store.get("card_1")).toEqual(afterActive);
  });

  it("keeps an unknown lead verdict across startup passes", async () => {
    const { store, service, classify, publish } = setup({
      getThread: async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      getThreadOutput: async () => ({ output: "Would normally call Jev" }),
      classify: async () => ({ decision: "unknown", probability: null }),
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });
    await service.onThreadIdle(thread("lead"), null);
    const before = store.get("card_1");
    classify.mockClear();
    publish.mockClear();

    await service.startupPass();
    await service.startupPass();

    expect(store.get("card_1")).toEqual(before);
    expect(classify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps parked idle cards stable across startup passes", async () => {
    const { store, service, classify, publish } = setup({
      getThread: async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      getThreadOutput: async ({ threadId }) => ({
        output:
          threadId === "lead" ? "Choose a deployment target" : "Question?",
      }),
      classify: async () => ({ decision: "needs", probability: 0.9 }),
    });
    seed(store, { id: "lead-card" });
    store.update("lead-card", { leadThreadId: "lead", ownerRole: "lead" });
    seed(store, { id: "intake-card" });
    store.update("intake-card", { intakeThreadId: "intake" });
    await service.onThreadIdle(thread("lead"), "Choose a deployment target");
    await service.onThreadIdle(thread("intake"), "Question?");
    const leadBefore = store.get("lead-card");
    const intakeBefore = store.get("intake-card");
    const leadHistoryLength = store.history("lead-card").length;
    const intakeHistoryLength = store.history("intake-card").length;
    publish.mockClear();

    await service.startupPass();
    await service.startupPass();

    expect(store.get("lead-card")).toEqual(leadBefore);
    expect(store.get("intake-card")).toEqual(intakeBefore);
    expect(store.history("lead-card")).toHaveLength(leadHistoryLength);
    expect(store.history("intake-card")).toHaveLength(intakeHistoryLength);
    expect(classify).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("replaces an archived warning when startup observes an idle thread", async () => {
    const { store, service } = setup({
      getThread: async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          status: "idle",
          archivedAt: null,
        }),
      getThreadOutput: async () => ({ output: "Work complete" }),
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });
    await service.onThreadGone(thread("lead", 0, { archivedAt: 1 }));
    expect(store.get("card_1")?.attentionReason).toBe("thread archived");

    await service.startupPass();

    expect(store.get("card_1")).toMatchObject({
      needsUser: false,
      attentionReason: null,
      attentionSource: null,
      attentionUnknown: false,
    });
  });

  it("reconciles a deleted thread after an unrelated tier change", async () => {
    let rejectLookup!: (reason: unknown) => void;
    const lookup = new Promise<ReturnType<typeof makeThreadResponse>>(
      (_resolve, reject) => {
        rejectLookup = reject;
      },
    );
    const getThread = vi.fn(async () => lookup);
    const { store, service } = setup({ getThread });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    const startup = service.startupPass();
    await vi.waitFor(() => expect(getThread).toHaveBeenCalledOnce());
    store.update("card_1", { tier: "small" });
    rejectLookup(
      Object.assign(new Error("thread not found"), {
        status: 404,
        code: "thread_not_found",
      }),
    );
    await startup;

    expect(store.get("card_1")).toMatchObject({
      tier: "small",
      leadThreadId: null,
      launchError: "lead: thread deleted",
      attentionReason: "thread deleted",
    });
  });

  it("ignores a startup observation overtaken by an intake handoff", async () => {
    let resolveLookup!: (
      value: ReturnType<typeof makeThreadResponse>,
    ) => void;
    const lookup = new Promise<ReturnType<typeof makeThreadResponse>>(
      (resolve) => {
        resolveLookup = resolve;
      },
    );
    const getThread = vi.fn(async () => lookup);
    const { store, service } = setup({
      getThread,
      getThreadOutput: async () => ({ output: "Old intake question" }),
    });
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });

    const startup = service.startupPass();
    await vi.waitFor(() => expect(getThread).toHaveBeenCalledOnce());
    await service.report({
      threadId: "intake",
      column: "planning",
      issueUrl: "https://github.com/o/r/issues/1",
      working: true,
    });
    resolveLookup(
      makeThreadResponse({ id: "intake", status: "idle" }),
    );
    await startup;

    expect(store.get("card_1")).toMatchObject({
      column: "planning",
      ownerRole: "lead",
      leadThreadId: "thr_1",
    });
  });

  it("leaves a live card unchanged when reading idle output fails", async () => {
    const { store, service, log } = setup({
      getThread: async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      getThreadOutput: async () => {
        throw new Error("temporary output failure");
      },
    });
    seed(store);
    const before = store.update("card_1", {
      leadThreadId: "lead",
      ownerRole: "lead",
    });

    await service.startupPass();

    expect(store.get("card_1")).toEqual(before);
    expect(log).toHaveBeenCalledWith(
      "startup pass failed for thread lead: temporary output failure",
    );
  });

  it("treats a missing startup thread as deleted", async () => {
    const { store, service } = setup({
      getThread: async () => {
        throw Object.assign(new Error("thread not found"), {
          status: 404,
          code: "thread_not_found",
        });
      },
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    await service.startupPass();

    expect(store.get("card_1")).toMatchObject({
      leadThreadId: null,
      launchError: "lead: thread deleted",
      attentionReason: "thread deleted",
    });
  });

  it("leaves a card unchanged on a non-404 startup lookup failure", async () => {
    const { store, service, log } = setup({
      getThread: async () => {
        throw Object.assign(new Error("host unavailable"), { status: 503 });
      },
    });
    seed(store);
    const before = store.update("card_1", {
      leadThreadId: "lead",
      ownerRole: "lead",
    });

    await service.startupPass();

    expect(store.get("card_1")).toEqual(before);
    expect(log).toHaveBeenCalledWith(
      "startup pass failed for thread lead: host unavailable",
    );
  });
});

describe("report and active state", () => {
  it.each(["intake", "lead"])("resolves a report by %s thread id", async (role) => {
    const { store, service } = setup();
    seed(store);
    store.update(
      "card_1",
      role === "intake"
        ? { intakeThreadId: role }
        : { leadThreadId: role, ownerRole: "lead" },
    );

    await service.report({ threadId: role, tier: "standard" });

    expect(store.get("card_1")?.tier).toBe("standard");
  });

  it("rejects an unknown reporting thread", async () => {
    const { service } = setup();
    await expect(service.report({ threadId: "missing", working: true })).rejects.toThrow("unknown card or pipeline thread");
  });

  it("records move and attention history for a combined report", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });

    await service.report({
      threadId: "intake",
      column: "todo",
      needsYou: "Choose a target",
    });

    expect(store.history("card_1").slice(-2)).toMatchObject([
      { kind: "moved", threadId: "intake", toColumn: "todo" },
      { kind: "attention", threadId: "intake", note: "Choose a target" },
    ]);
  });

  it("clears attention, runtime error, and report signal on active", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", {
      leadThreadId: "lead",
      ownerRole: "lead",
      needsUser: true,
      attentionReason: "Choose",
      attentionSource: "report",
      attentionUnknown: true,
      threadError: "boom",
      launchError: "lead: start cancelled",
      reportSignal: "needs_you",
    });

    await service.onThreadActive(thread("lead", 0, { status: "active" }));

    expect(store.get("card_1")).toMatchObject({
      needsUser: false,
      attentionReason: null,
      attentionUnknown: false,
      threadError: null,
      launchError: null,
      reportSignal: null,
    });
  });

  it("defaults a Jev threshold below 0.5", async () => {
    const { store, service, classify } = setup({
      settings: { ...settings, jevThreshold: "0.3" },
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    await service.onThreadIdle(thread("lead"), "Need a decision?");

    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 0.7 }),
    );
  });

});

describe("execution selection", () => {
  it("falls back to intake defaults only while every lead setting is unset", async () => {
    const inherited = setup({
      settings: {
        ...settings,
        providerId: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "ultra",
        serviceTier: "fast",
      },
    });
    await expect(inherited.service.getExecutionDefaults()).resolves.toEqual({
      intake: {
        providerId: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "ultra",
        serviceTier: "fast",
      },
      lead: {
        providerId: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "ultra",
        serviceTier: "fast",
      },
    });

    const explicitLead = setup({
      settings: {
        ...settings,
        providerId: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "ultra",
        serviceTier: "fast",
        leadProviderId: "pi",
        leadModel: "zai/glm-5.3-flash",
        leadReasoningLevel: "high",
      },
    });
    expect((await explicitLead.service.getExecutionDefaults()).lead).toEqual({
      providerId: "pi",
      model: "zai/glm-5.3-flash",
      reasoningLevel: "high",
    });
  });

  it("rejects an unavailable lead model before inserting or launching intake", async () => {
    const {
      service,
      store,
      spawn,
      rememberExecution,
      listProviders,
      listProviderModels,
    } = setup();

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "host_mac",
        lead: { providerId: "pi", model: "zai/missing" },
        title: "Ship it",
        source: "ui",
      }),
    ).rejects.toThrow(
      'lead model "zai/missing" is unavailable for provider "pi" on machine "Mac" (host_mac)',
    );

    expect(listProviders).toHaveBeenCalledWith({ hostId: "host_mac" });
    expect(listProviderModels).toHaveBeenCalledWith({
      hostId: "host_mac",
      providerId: "pi",
    });
    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(rememberExecution).not.toHaveBeenCalled();
  });

  it("rejects reasoning unsupported by the selected model", async () => {
    const { service, store, spawn, rememberExecution } = setup();

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "host_mac",
        intake: { reasoningLevel: "low" },
        title: "Ship it",
        source: "cli",
      }),
    ).rejects.toThrow(
      'intake reasoning "low" is unsupported by model "claude-fable-5-1" on machine "Mac" (host_mac)',
    );

    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(rememberExecution).not.toHaveBeenCalled();
  });

  it("deduplicates same-provider discovery and routes it to the selected host", async () => {
    const { service, listProviders, listProviderModels } = setup();

    await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship it",
      source: "cli",
    });

    expect(listProviders).toHaveBeenCalledOnce();
    expect(listProviders).toHaveBeenCalledWith({ hostId: "host_mac" });
    expect(listProviderModels).toHaveBeenCalledOnce();
    expect(listProviderModels).toHaveBeenCalledWith({
      hostId: "host_mac",
      providerId: "claude-code",
    });
  });

  it("rejects an unknown provider before model discovery or insertion", async () => {
    const {
      service,
      store,
      spawn,
      rememberExecution,
      listProviderModels,
    } = setup();

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "host_mac",
        intake: { providerId: "missing", model: "missing-model" },
        title: "Ship it",
        source: "cli",
      }),
    ).rejects.toThrow(
      'intake provider "missing" is not installed on machine "Mac" (host_mac)',
    );

    expect(listProviderModels).not.toHaveBeenCalled();
    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(rememberExecution).not.toHaveBeenCalled();
  });

  it("rejects a provider unavailable on the selected host", async () => {
    const { service, store, spawn, listProviderModels } = setup({
      listProviders: async () => [
        makeCatalogProvider("claude-code", false, false),
        ...testCatalogProviders.filter(
          (candidate) => candidate.id !== "claude-code",
        ),
      ],
    });

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "host_mac",
        title: "Ship it",
        source: "cli",
      }),
    ).rejects.toThrow(
      'intake provider "claude-code" is unavailable on machine "Mac" (host_mac)',
    );

    expect(listProviderModels).not.toHaveBeenCalled();
    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects service tiers unsupported by the provider", async () => {
    const { service, store, spawn, rememberExecution } = setup();

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "host_mac",
        intake: { serviceTier: "fast" },
        title: "Ship it",
        source: "ui",
      }),
    ).rejects.toThrow(
      'intake service tier "fast" is unsupported by provider "claude-code" on machine "Mac" (host_mac)',
    );

    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(rememberExecution).not.toHaveBeenCalled();
  });

  it("rejects catalog load failures before insertion", async () => {
    const { service, store, spawn, rememberExecution } = setup({
      listProviderModels: async () => {
        throw new Error("catalog timed out");
      },
    });

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "host_mac",
        title: "Ship it",
        source: "cli",
      }),
    ).rejects.toThrow(
      'could not load intake models for provider "claude-code" on machine "Mac" (host_mac): catalog timed out',
    );

    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(rememberExecution).not.toHaveBeenCalled();
  });

  it("preserves offline creation without catalog validation", async () => {
    const {
      service,
      store,
      spawn,
      rememberExecution,
      listProviders,
      listProviderModels,
    } = setup({
      project: twoMachineProject,
      spawn: async () => {
        throw new Error("machine offline");
      },
    });

    const card = await service.createCard({
      projectId: "proj_1",
      hostId: "host_linux",
      intake: { providerId: "offline-provider", model: "offline-model" },
      lead: { providerId: "offline-provider", model: "offline-model" },
      title: "Ship it later",
      source: "cli",
    });

    expect(card).toMatchObject({
      hostId: "host_linux",
      intake: { providerId: "offline-provider", model: "offline-model" },
      launchError: "intake: machine offline",
    });
    expect(store.list("proj_1", true)).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(rememberExecution).toHaveBeenCalledOnce();
    expect(listProviders).not.toHaveBeenCalled();
    expect(listProviderModels).not.toHaveBeenCalled();
  });

  it("captures distinct resolved choices for intake, lead, and ordinary retries", async () => {
    const mutableSettings: PipelineSettings = {
      ...settings,
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "ultra",
      serviceTier: "default",
      leadProviderId: "pi",
      leadModel: "zai/glm-5.3-flash",
      leadReasoningLevel: "high",
    };
    let failLead = true;
    let threadNumber = 1;
    const { service, store, spawn, rememberExecution } = setup({
      settings: mutableSettings,
      spawn: async (request) => {
        if (
          (request as { pluginMetadata?: { role?: string } }).pluginMetadata
            ?.role === "lead" &&
          failLead
        ) {
          throw new Error("offline");
        }
        return makeThreadResponse({ id: `thread_${threadNumber++}` });
      },
    });

    const created = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      intake: { serviceTier: "fast" },
      lead: { model: "zai/glm-5.3-air", reasoningLevel: "max" },
      title: "Ship it",
      source: "ui",
    });
    const captured = {
      intake: {
        providerId: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "ultra" as const,
        serviceTier: "fast" as const,
      },
      lead: {
        providerId: "pi",
        model: "zai/glm-5.3-air",
        reasoningLevel: "max" as const,
      },
    };
    expect(store.get(created.id)).toMatchObject(captured);
    expect(rememberExecution).toHaveBeenCalledOnce();
    expect(rememberExecution).toHaveBeenCalledWith(captured);
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "ultra",
      serviceTier: "fast",
    });

    Object.assign(mutableSettings, {
      providerId: "changed-intake",
      model: "changed-model",
      reasoningLevel: "none",
      serviceTier: undefined,
      leadProviderId: "changed-lead",
      leadModel: "changed-lead-model",
      leadReasoningLevel: "low",
      leadServiceTier: "fast",
    });
    await service.report({
      cardId: created.id,
      issueUrl: "https://github.com/o/r/issues/1",
      column: "planning",
    });
    expect(store.get(created.id)?.launchError).toContain("lead: offline");

    failLead = false;
    Object.assign(mutableSettings, {
      leadProviderId: "changed-again",
      leadModel: "changed-again-model",
      leadReasoningLevel: "ultra",
    });
    await service.retry(created.id);

    for (const request of spawn.mock.calls.slice(1).map(([request]) => request)) {
      expect(request).toMatchObject({
        providerId: "pi",
        model: "zai/glm-5.3-air",
        reasoningLevel: "max",
      });
      expect(request).not.toHaveProperty("serviceTier");
    }
  });

  it("clears an inherited service tier when a provider override changes", async () => {
    const { service, store, rememberExecution } = setup({
      settings: {
        ...settings,
        providerId: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "ultra",
        serviceTier: "fast",
      },
    });

    const card = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      lead: {
        providerId: "pi",
        model: "zai/glm-5.3-flash",
        reasoningLevel: "high",
      },
      title: "Ship it",
      source: "cli",
    });

    expect(store.get(card.id)?.lead).toEqual({
      providerId: "pi",
      model: "zai/glm-5.3-flash",
      reasoningLevel: "high",
    });
    expect(rememberExecution.mock.calls[0]![0].lead).not.toHaveProperty(
      "serviceTier",
    );
  });

  it("retries a cancelled kickoff with its captured model, reasoning, and tier", async () => {
    const mutableSettings: PipelineSettings = { ...settings };
    const { service, store, send, listEnvironments } = setup({
      settings: mutableSettings,
      getThread: async ({ threadId }) =>
        thread(threadId, 0, { status: "pending", queuedMessageCount: 0 }),
    });
    const selected = {
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "ultra" as const,
      serviceTier: "fast" as const,
    };
    seed(store, { intake: selected });
    await service.launch("card_1", "intake");
    const threadId = store.get("card_1")!.intakeThreadId!;
    await service.onThreadQueueChanged(
      thread(threadId, 0, { status: "pending", queuedMessageCount: 0 }),
    );
    Object.assign(mutableSettings, {
      providerId: "pi",
      model: "changed",
      reasoningLevel: "low",
      serviceTier: "default",
    });
    listEnvironments.mockRejectedValue(new Error("workspace discovery unavailable"));

    await service.retry("card_1");

    expect(listEnvironments).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      threadId,
      mode: "auto",
      input: expect.any(Array),
      model: "gpt-6-astra",
      reasoningLevel: "ultra",
      serviceTier: "fast",
      permissionMode: "full",
    });
  });

  it.each([
    { role: "intake", selection: { providerId: "   " } },
    { role: "lead", selection: { reasoningLevel: "turbo" } },
  ])("rejects an invalid $role choice before creating or spawning", async ({ role, selection }) => {
    const { service, store, spawn, rememberExecution } = setup();

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "host_mac",
        [role]: selection,
        title: "Ship it",
        source: "cli",
      } as Parameters<typeof service.createCard>[0]),
    ).rejects.toThrow();

    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(rememberExecution).not.toHaveBeenCalled();
  });

  it("keeps an inserted card and launches once when remembering fails", async () => {
    const { service, store, spawn, rememberExecution, log } = setup({
      rememberExecution: async () => {
        throw new Error("settings unavailable");
      },
    });

    const card = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship it",
      source: "ui",
    });

    expect(store.list("proj_1", true)).toHaveLength(1);
    expect(card.intakeThreadId).toBe("thr_1");
    expect(rememberExecution).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("could not remember execution for card card_new: settings unavailable"),
    );
  });

  it("links intake while remembering remains pending", async () => {
    let releaseRemember!: () => void;
    const remembering = new Promise<void>((resolve) => {
      releaseRemember = resolve;
    });
    const { service, store, spawn, rememberExecution } = setup({
      rememberExecution: async () => remembering,
    });

    const creating = service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship it",
      source: "ui",
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(store.get("card_new")?.intakeThreadId).toBe("thr_1");
    expect(rememberExecution).toHaveBeenCalledOnce();

    releaseRemember();
    await expect(creating).resolves.toMatchObject({ intakeThreadId: "thr_1" });
  });
});

describe("saved cards", () => {
  const attachments: CardAttachment[] = [
    {
      path: "attachments/spec.md",
      filename: "spec.md",
      mimeType: "text/markdown",
      sizeBytes: 42,
      isImage: false,
    },
  ];

  it("persists through a reopened store and startup without spawning", async () => {
    const { db, service, store, spawn, rememberExecution } = setup();

    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });

    expect(saved).toMatchObject({
      startRequested: false,
      intakeThreadId: null,
      launchError: null,
    });
    expect(createCardStore(db).get(saved.id)).toMatchObject({
      startRequested: false,
      intakeThreadId: null,
    });
    await service.startupPass();
    expect(store.get(saved.id)?.startRequested).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(rememberExecution).toHaveBeenCalledOnce();
  });

  it("turns an interrupted start with no remote thread into a retryable launch", async () => {
    const listThreads = vi.fn(async () => [] as ThreadListResult);
    const { service, store, spawn } = setup({ listThreads });
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });
    store.update(
      saved.id,
      { startRequested: true },
      { kind: "start_requested", source: "ui" },
    );

    await service.startupPass();

    expect(store.get(saved.id)?.launchError).toBe(
      "intake: start interrupted before its thread was linked",
    );
    expect(spawn).not.toHaveBeenCalled();

    await service.retry(saved.id);

    expect(store.get(saved.id)).toMatchObject({
      intakeThreadId: "thr_1",
      launchError: null,
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("adopts a delayed original intake before Retry can spawn a duplicate", async () => {
    let remoteExists = false;
    const listThreads = vi.fn(async (input: ThreadListInput) =>
      remoteExists && !input.archived
        ? [listedThread("delayed-intake")]
        : [],
    );
    const { service, store, spawn, send } = setup({
      listThreads,
      getThreadMetadata: async () => ({ cardId: "card_new", role: "intake" }),
      getThread: async ({ threadId }) =>
        thread(threadId, 0, { status: "pending", queuedMessageCount: 1 }),
    });
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });
    store.update(
      saved.id,
      { startRequested: true },
      { kind: "start_requested", source: "ui" },
    );
    await service.startupPass();
    remoteExists = true;

    const recovered = await service.retry(saved.id);

    expect(recovered).toMatchObject({
      intakeThreadId: "delayed-intake",
      launchError: null,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("pages Pipeline threads and adopts a matching intake during startup", async () => {
    const orphanId = "orphan-intake";
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      listedThread(`other-${index}`),
    );
    const listThreads = vi.fn(async (input: ThreadListInput) => {
      if (input.archived) return [];
      return input.offset === 0 ? firstPage : [listedThread(orphanId)];
    });
    const { service, store, spawn, send } = setup({
      listThreads,
      getThreadMetadata: async ({ threadId }) =>
        threadId === orphanId
          ? { cardId: "card_new", role: "intake" }
          : { cardId: "other", role: "intake" },
      getThread: async ({ threadId }) =>
        thread(threadId, 0, { status: "pending", queuedMessageCount: 1 }),
    });
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });
    store.update(
      saved.id,
      { startRequested: true },
      { kind: "start_requested", source: "ui" },
    );

    await service.startupPass();

    expect(store.get(saved.id)).toMatchObject({
      intakeThreadId: orphanId,
      launchError: null,
    });
    expect(listThreads.mock.calls.map(([input]) => input.offset)).toEqual([
      0,
      100,
    ]);
    expect(listThreads.mock.calls[0]![0]).toMatchObject({
      projectId: "proj_1",
      originPluginId: "pipeline",
      includeHidden: true,
      archived: false,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("adopts an archived orphan on repeated Start before startup runs", async () => {
    const listThreads = vi.fn(async (input: ThreadListInput) =>
      input.archived ? [listedThread("archived-intake")] : [],
    );
    const { service, store, spawn, send } = setup({
      listThreads,
      getThreadMetadata: async () => ({ cardId: "card_new", role: "intake" }),
      getThread: async ({ threadId }) =>
        thread(threadId, 0, { archivedAt: 1 }),
    });
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });
    store.update(
      saved.id,
      { startRequested: true },
      { kind: "start_requested", source: "ui" },
    );

    const recovered = await service.start(saved.id, "cli");

    expect(recovered).toMatchObject({
      intakeThreadId: "archived-intake",
      attentionReason: "thread archived",
    });
    expect(listThreads.mock.calls.map(([input]) => input.archived)).toEqual([
      false,
      true,
    ]);
    expect(spawn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("waits for a current-process start before startup recovery", async () => {
    let resolveSpawn!: (value: ReturnType<typeof makeThreadResponse>) => void;
    const pendingSpawn = new Promise<ReturnType<typeof makeThreadResponse>>(
      (resolve) => {
        resolveSpawn = resolve;
      },
    );
    const listThreads = vi.fn(async () => {
      throw new Error("recovery should not scan");
    });
    const { service, store, spawn } = setup({
      spawn: async () => pendingSpawn,
      listThreads,
      getThread: async ({ threadId }) =>
        thread(threadId, 0, { status: "pending", queuedMessageCount: 1 }),
    });
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });

    const starting = service.start(saved.id, "ui");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const startup = service.startupPass();
    resolveSpawn(thread("intake-current"));
    await Promise.all([starting, startup]);

    expect(store.get(saved.id)).toMatchObject({
      intakeThreadId: "intake-current",
      launchError: null,
    });
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("does not spawn when interrupted-start discovery is unavailable", async () => {
    const listThreads = vi.fn(async () => {
      throw new Error("metadata service unavailable");
    });
    const { service, store, spawn } = setup({ listThreads });
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });
    store.update(
      saved.id,
      { startRequested: true },
      { kind: "start_requested", source: "ui" },
    );

    await service.startupPass();
    await service.retry(saved.id);

    expect(store.get(saved.id)?.launchError).toContain(
      "could not check for an existing intake thread: metadata service unavailable",
    );
    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("clears saved attention when accepting the first Start", async () => {
    const { service, store, onAttention } = setup();
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });
    store.update(saved.id, {
      needsUser: true,
      attentionReason: "Old question",
      attentionSource: "report",
      attentionUnknown: true,
      reportSignal: "needs_you",
      threadError: "old thread failure",
      launchError: "old launch failure",
    });

    const started = await service.start(saved.id, "ui");

    expect(started).toMatchObject({
      needsUser: false,
      attentionReason: null,
      attentionSource: null,
      attentionUnknown: false,
      reportSignal: null,
      threadError: null,
      launchError: null,
    });
    expect(onAttention).not.toHaveBeenCalled();
  });

  it("reports the fresh launch failure after clearing saved attention", async () => {
    const { service, store, onAttention } = setup({
      spawn: async () => {
        throw new Error("machine offline");
      },
    });
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });
    store.update(saved.id, {
      needsUser: true,
      attentionReason: "Old question",
      attentionSource: "report",
      reportSignal: "needs_you",
      threadError: "old thread failure",
      launchError: "old launch failure",
    });

    const started = await service.start(saved.id, "ui");

    expect(started).toMatchObject({
      needsUser: false,
      attentionReason: null,
      reportSignal: null,
      threadError: null,
      launchError: "intake: machine offline",
    });
    expect(onAttention).toHaveBeenCalledOnce();
    expect(onAttention.mock.calls[0]![1]).toBe(
      "Launch failed: intake: machine offline",
    );
  });

  it("starts once with its captured machine, execution, and attachments", async () => {
    const mutableSettings: PipelineSettings = {
      ...settings,
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "ultra",
      serviceTier: "fast",
    };
    const { service, spawn, store } = setup({ settings: mutableSettings });
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      intake: { serviceTier: "default" },
      lead: {
        providerId: "pi",
        model: "zai/glm-5.3-flash",
        reasoningLevel: "high",
      },
      title: "Ship later",
      body: "Use the saved inputs",
      attachments,
      start: false,
      source: "cli",
    });
    Object.assign(mutableSettings, {
      providerId: "pi",
      model: "changed",
      reasoningLevel: "none",
      serviceTier: undefined,
    });

    const [first, second] = await Promise.all([
      service.start(saved.id, "ui"),
      service.start(saved.id, "cli"),
    ]);

    expect(first.intakeThreadId).toBe("thr_1");
    expect(second.intakeThreadId).toBe("thr_1");
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      environment: { type: "reuse", environmentId: "env_checkout" },
      pluginMetadata: { hostId: "host_mac" },
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "ultra",
      serviceTier: "default",
      input: expect.arrayContaining([
        expect.objectContaining({
          type: "localFile",
          path: "attachments/spec.md",
          name: "spec.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
        }),
      ]),
    });
    expect(store.history(saved.id).filter((entry) => entry.kind === "start_requested")).toEqual([
      expect.objectContaining({ source: "ui" }),
    ]);
    await expect(service.start(saved.id, "cli")).resolves.toEqual(store.get(saved.id));
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("keeps failed start intent durable and recovers through Retry", async () => {
    let offline = true;
    const { service, spawn, store } = setup({
      spawn: async () => {
        if (offline) throw new Error("machine offline");
        return thread("intake-retry");
      },
    });
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });

    await service.start(saved.id, "ui");
    expect(store.get(saved.id)).toMatchObject({
      startRequested: true,
      intakeThreadId: null,
      launchError: "intake: machine offline",
    });
    await service.start(saved.id, "cli");
    expect(spawn).toHaveBeenCalledOnce();

    offline = false;
    await service.retry(saved.id);
    expect(store.get(saved.id)).toMatchObject({
      startRequested: true,
      intakeThreadId: "intake-retry",
      launchError: null,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not accept the first start request for completed or held cards", async () => {
    const completed = setup();
    const completedCard = await completed.service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Already done",
      start: false,
      source: "ui",
    });
    completed.store.update(completedCard.id, { column: "done" });
    await expect(completed.service.start(completedCard.id, "ui")).rejects.toThrow(
      "Completed tasks cannot be started",
    );
    expect(completed.store.get(completedCard.id)?.startRequested).toBe(false);
    expect(completed.spawn).not.toHaveBeenCalled();

    const held = setup();
    const heldCard = await held.service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Held before start",
      start: false,
      source: "cli",
    });
    held.store.update(heldCard.id, { runState: "paused" });
    await expect(held.service.start(heldCard.id, "cli")).rejects.toThrow(
      "resume it before starting it",
    );
    expect(held.store.get(heldCard.id)?.startRequested).toBe(false);
    expect(held.spawn).not.toHaveBeenCalled();
  });

  it("rejects indirect starts but allows quiet metadata reports and removal", async () => {
    const { service, spawn, store, onAttention } = setup();
    const saved = await service.createCard({
      projectId: "proj_1",
      hostId: "host_mac",
      title: "Ship later",
      start: false,
      source: "ui",
    });

    await expect(service.launch(saved.id, "intake")).rejects.toThrow("start it before launching it");
    await expect(service.retry(saved.id)).rejects.toThrow("start it before retrying it");
    await expect(service.move(saved.id, "todo", "ui")).rejects.toThrow("start it before moving it");
    await expect(service.report({ cardId: saved.id, column: "todo" })).rejects.toThrow(
      "start it before changing its phase or owner",
    );

    await service.report({
      cardId: saved.id,
      tier: "small",
      needsYou: "Keep this note",
    });
    expect(store.get(saved.id)).toMatchObject({
      startRequested: false,
      tier: "small",
      needsUser: true,
      attentionReason: "Keep this note",
      intakeThreadId: null,
    });
    expect(onAttention).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(service.remove(saved.id)).toBe(true);
  });
});

describe("intake checkout reuse", () => {
  it("reuses a shared checkout with preserved provider inputs for concurrent intakes", async () => {
    const environment = makeCheckoutEnvironment();
    const original = structuredClone(environment);
    const { service, store, spawn, listEnvironments } = setup({
      project: { ...project, sources: [{ ...projectSource, path: "/repo///" }] },
      listEnvironments: async () => [environment],
    });
    for (const id of ["one", "two", "three"]) seed(store, { id });

    await Promise.all(["one", "two", "three"].map((id) => service.launch(id, "intake")));

    expect(spawn).toHaveBeenCalledTimes(3);
    for (const [request] of spawn.mock.calls) {
      expect(request).toMatchObject({
        environment: { type: "reuse", environmentId: environment.id },
        pluginMetadata: { role: "intake", hostId: "host_mac" },
      });
      expect((request as { environment: unknown }).environment).toEqual({
        type: "reuse", environmentId: environment.id,
      });
    }
    expect(listEnvironments).toHaveBeenCalledWith({ projectId: "proj_1", hostId: "host_mac", path: "/repo" });
    expect(environment).toEqual(original);
  });

  it.each([
    makeCheckoutEnvironment({ status: "creating" }),
    makeCheckoutEnvironment({ status: "provisioning" }),
    makeCheckoutEnvironment({ status: "error" }),
    makeCheckoutEnvironment({ lifecycle: { phase: "retiring", retireAt: 123, teardown: null } }),
    makeCheckoutEnvironment({ lifecycle: { phase: "teardown", retireAt: 123, teardown: { status: "running", attempt: 1 } } }),
  ])("does not prepare a checkout in $status/$lifecycle.phase", async (environment) => {
    const { service, store, spawn } = setup({ listEnvironments: async () => [environment] });
    seed(store);

    const failed = await service.launch("card_1", "intake");

    expect(failed.launchError).toContain(`${environment.status}/${environment.lifecycle.phase}`);
    expect(failed.intakeThreadId).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["missing", "lookup failure"])("offers Retry without preparing a checkout after %s", async (failure) => {
    let ready = false;
    const { service, store, spawn, listEnvironments } = setup({
      listEnvironments: async () => {
        if (ready) return [makeCheckoutEnvironment()];
        if (failure === "lookup failure") throw new Error("discovery unavailable");
        return [];
      },
    });
    seed(store);
    const failed = await service.launch("card_1", "intake");

    expect(failed.launchError).toContain(failure === "missing" ? "open the project checkout" : "discovery unavailable");
    expect(failed.intakeThreadId).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    ready = true;

    const retried = await service.retry("card_1");

    expect(retried).toMatchObject({ launchError: null, intakeThreadId: "thr_1" });
    expect(listEnvironments).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      environment: { type: "reuse", environmentId: "env_checkout" },
    }));
  });

  it("does not fall back to preparation if the checkout becomes busy before spawn", async () => {
    let busy = true;
    const { service, store, spawn } = setup({
      spawn: async () => {
        if (busy) throw Object.assign(new Error("workspace is being prepared"), { status: 409, code: "workspace_busy" });
        return makeThreadResponse({ id: "intake" });
      },
    });
    seed(store);

    const failed = await service.launch("card_1", "intake");
    expect(failed.launchError).toContain("workspace is being prepared");
    expect(spawn).toHaveBeenCalledOnce();
    busy = false;
    await service.retry("card_1");

    expect(spawn).toHaveBeenCalledTimes(2);
    for (const [request] of spawn.mock.calls) {
      expect((request as { environment: unknown }).environment).toEqual({
        type: "reuse", environmentId: "env_checkout",
      });
    }
    expect(store.get("card_1")?.launchError).toBeNull();
  });
});

describe("machine selection", () => {
  it.each(["", "   "])(
    "rejects a %j machine before creating a card or thread",
    async (hostId) => {
      const { store, service, spawn } = setup();

      await expect(
        service.createCard({
          projectId: "proj_1",
          hostId,
          title: "Ship it",
          source: "cli",
        }),
      ).rejects.toThrow("choose a machine for this card");

      expect(store.list("proj_1", true)).toHaveLength(0);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown machine before creating a card or thread", async () => {
    const { store, service, spawn } = setup();

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "host_missing",
        title: "Ship it",
        source: "cli",
      }),
    ).rejects.toThrow('unknown machine "host_missing"');

    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a machine without a project checkout before creating a card or thread", async () => {
    const { store, service, spawn } = setup();

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "host_linux",
        title: "Ship it",
        source: "cli",
      }),
    ).rejects.toThrow('unknown machine "host_linux"');

    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous machine name before creating a card or thread", async () => {
    const { store, service, spawn } = setup({
      project: twoMachineProject,
      hosts: [
        makeHostResponse({ id: "host_mac", name: "Box", status: "connected" }),
        makeHostResponse({ id: "host_linux", name: "Box", status: "connected" }),
      ],
    });

    await expect(
      service.createCard({
        projectId: "proj_1",
        hostId: "Box",
        title: "Ship it",
        source: "cli",
      }),
    ).rejects.toThrow('machine "Box" is ambiguous');

    expect(store.list("proj_1", true)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("launches intake on the selected machine when several have checkouts", async () => {
    const { service, spawn, listEnvironments } = setup({ project: twoMachineProject });

    const card = await service.createCard({
      projectId: "proj_1",
      hostId: "host_linux",
      title: "Ship it",
      source: "cli",
    });

    expect(card.hostId).toBe("host_linux");
    expect(spawn).toHaveBeenCalledOnce();
    const request = spawn.mock.calls[0]![0] as {
      environment: { type: string; environmentId: string };
      pluginMetadata: { cardId: string; hostId: string };
    };
    expect(listEnvironments).toHaveBeenCalledWith({
      projectId: "proj_1", hostId: "host_linux", path: "/repo-linux",
    });
    expect(request.pluginMetadata).toMatchObject({ cardId: card.id, hostId: "host_linux" });
    expect(request.environment).toEqual({
      type: "reuse", environmentId: "env_checkout",
    });
  });

  it("keeps the selected machine for the lead launch and a retry", async () => {
    let leadFails = true;
    let nextThread = 1;
    const { store, service, spawn } = setup({
      project: twoMachineProject,
      spawn: async (request) => {
        const role = (
          request as { pluginMetadata?: { role?: string } }
        ).pluginMetadata?.role;
        if (role === "lead" && leadFails) throw new Error("host offline");
        return makeThreadResponse({ id: `thr_${nextThread++}` });
      },
    });
    const card = await service.createCard({
      projectId: "proj_1",
      hostId: "host_linux",
      title: "Ship it",
      source: "cli",
    });

    await service.report({
      cardId: card.id,
      issueUrl: "https://github.com/o/r/issues/1",
      column: "planning",
    });
    expect(store.get(card.id)?.launchError).toContain("lead: host offline");

    leadFails = false;
    const retried = await service.retry(card.id);
    expect(retried.leadThreadId).not.toBeNull();

    expect(spawn.mock.calls.map(([request]) => (request as { environment: unknown }).environment)).toEqual([
      { type: "reuse", environmentId: "env_checkout" },
      { type: "host", hostId: "host_linux", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      { type: "host", hostId: "host_linux", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
    ]);
  });

  it("fails a legacy card's launch clearly until a machine is assigned", async () => {
    const { db, store, service, spawn } = setup();
    seedLegacyRow(db);

    await service.launch("card_legacy", "intake");

    expect(store.get("card_legacy")?.launchError).toContain(
      "card has no machine assigned",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("assigns a machine to a legacy card once and enables launches", async () => {
    const { db, store, service, spawn } = setup();
    seedLegacyRow(db);

    const assigned = await service.setMachine("card_legacy", "Mac");

    expect(assigned.hostId).toBe("host_mac");
    expect(assigned.revision).toBe(1);
    expect(store.history("card_legacy").at(-1)).toMatchObject({
      kind: "machine_assigned",
      note: "host_mac",
    });

    await service.launch("card_legacy", "intake");

    expect(spawn).toHaveBeenCalledOnce();
    const request = spawn.mock.calls[0]![0] as {
      environment: { type: string; environmentId: string };
      pluginMetadata: { hostId: string };
    };
    expect(request.environment).toEqual({ type: "reuse", environmentId: "env_checkout" });
    expect(request.pluginMetadata.hostId).toBe("host_mac");
  });

  it("rejects changing an assigned card's machine but allows the same machine", async () => {
    const { store, service } = setup({ project: twoMachineProject });
    seed(store);
    const before = store.get("card_1")!;
    const historyLength = store.history("card_1").length;

    await expect(
      service.setMachine("card_1", "host_linux"),
    ).rejects.toThrow("already assigned to machine host_mac");

    await service.setMachine("card_1", "host_mac");

    expect(store.get("card_1")).toEqual(before);
    expect(store.history("card_1")).toHaveLength(historyLength);
  });

  it("rejects setMachine for an unknown machine without changing the card", async () => {
    const { db, store, service } = setup();
    seedLegacyRow(db);

    await expect(
      service.setMachine("card_legacy", "host_missing"),
    ).rejects.toThrow('unknown machine "host_missing"');
    expect(store.get("card_legacy")?.hostId).toBeNull();
  });

  it("resolves an exact machine id before its name", async () => {
    const { db, store, service } = setup({
      project: twoMachineProject,
      hosts: [
        makeHostResponse({ id: "host_mac", name: "host_linux" }),
        makeHostResponse({ id: "host_linux", name: "Linux box" }),
      ],
    });
    seedLegacyRow(db);

    const assigned = await service.setMachine("card_legacy", "host_linux");

    expect(assigned.hostId).toBe("host_linux");
    expect(store.get("card_legacy")?.hostId).toBe("host_linux");
  });
});
