import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import {
  createPipelineService,
  type PipelineSettings,
} from "../lib/service";
import {
  createCardStore,
  MIGRATIONS,
  ownerThread,
  type CardAttachment,
} from "../lib/store";
import type { Database } from "better-sqlite3";

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

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function setup(options?: {
  spawn?: (request: unknown) => Promise<ReturnType<typeof makeThreadResponse>>;
  send?: (request: unknown) => Promise<{ ok: true; delivery: "sent" }>;
  getThread?: (input: { threadId: string }) => Promise<ReturnType<typeof makeThreadResponse>>;
  getThreadOutput?: (input: { threadId: string }) => Promise<{ output: string }>;
  project?: typeof project;
  hosts?: typeof hostList;
  readIssue?: (url: string) => Promise<{ title: string; body: string; labels: string[] }>;
  classify?: (input: unknown) => Promise<{ decision: "needs" | "no" | "unknown"; probability: number | null }>;
  settings?: PipelineSettings;
}) {
  let nextThread = 1;
  const spawn = vi.fn(
    options?.spawn ??
      (async () => makeThreadResponse({ id: `thr_${nextThread++}` })),
  );
  const send = vi.fn(
    options?.send ?? (async () => ({ ok: true as const, delivery: "sent" as const })),
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
      threads: {
        spawn: spawn as never,
        send: send as never,
        ...(options?.getThread === undefined
          ? {}
          : { get: options.getThread as never }),
        ...(options?.getThreadOutput === undefined
          ? {}
          : { output: options.getThreadOutput as never }),
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
  const log = vi.fn();
  const service = createPipelineService({
    store,
    sdk: host.bb.sdk as PluginBbSdk,
    getSettings: async () => options?.settings ?? settings,
    readIssue,
    classify,
    log,
    publish,
    id: () => "card_new",
  });
  return { host, db: host.bb.storage.database(), store, service, spawn, send, classify, readIssue, publish, log };
}

function seed(
  store: ReturnType<typeof setup>["store"],
  options?: { id?: string; hostId?: string; attachments?: CardAttachment[] },
) {
  return store.create({
    id: options?.id ?? "card_1",
    projectId: "proj_1",
    hostId: options?.hostId ?? "host_mac",
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

describe("idle policy", () => {
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
    const { store, service } = setup({
      classify: async () => ({ decision, probability: decision === "needs" ? 0.9 : decision === "no" ? 0.1 : 0.5 }),
    });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });
    const message = `status ${"x".repeat(220)} question`;

    await service.onThreadIdle(thread("lead"), message);

    expect(store.get("card_1")).toMatchObject({ needsUser, attentionUnknown: unknown });
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
    const { service, spawn } = setup({ project: twoMachineProject });

    const card = await service.createCard({
      projectId: "proj_1",
      hostId: "host_linux",
      title: "Ship it",
      source: "cli",
    });

    expect(card.hostId).toBe("host_linux");
    expect(spawn).toHaveBeenCalledOnce();
    const request = spawn.mock.calls[0]![0] as {
      environment: { hostId: string; workspace: { type: string; path: string } };
    };
    expect(request.environment.hostId).toBe("host_linux");
    expect(request.environment.workspace).toEqual({
      type: "unmanaged",
      path: "/repo-linux",
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

    const launchedHosts = spawn.mock.calls.map(
      (call) =>
        (call[0] as { environment: { hostId: string } }).environment.hostId,
    );
    expect(launchedHosts).toEqual([
      "host_linux",
      "host_linux",
      "host_linux",
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
      environment: { hostId: string };
    };
    expect(request.environment.hostId).toBe("host_mac");
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
