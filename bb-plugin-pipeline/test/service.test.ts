import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
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

const settings: PipelineSettings = {
  hostId: "host_mac",
  providerId: "claude-code",
  model: "claude-fable-5-1",
  reasoningLevel: "high",
  permissionMode: "full",
  jevApiKey: "jev-key",
  jevThreshold: "0.7",
};

const project = {
  id: "proj_1",
  kind: "standard",
  name: "Example",
  gitRemoteUrl: "https://github.com/example/repo",
  createdAt: 1,
  updatedAt: 1,
  sources: [
    {
      id: "source_1",
      projectId: "proj_1",
      type: "local_path",
      hostId: "host_mac",
      path: "/repo",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function setup(options?: {
  spawn?: (request: unknown) => Promise<ReturnType<typeof makeThreadResponse>>;
  getThread?: (input: { threadId: string }) => Promise<ReturnType<typeof makeThreadResponse>>;
  getThreadOutput?: (input: { threadId: string }) => Promise<{ output: string }>;
  project?: typeof project;
  readIssue?: (url: string) => Promise<{ title: string; body: string; labels: string[] }>;
  classify?: (input: unknown) => Promise<{ decision: "needs" | "no" | "unknown"; probability: number | null }>;
  settings?: PipelineSettings;
}) {
  let nextThread = 1;
  const spawn = vi.fn(
    options?.spawn ??
      (async () => makeThreadResponse({ id: `thr_${nextThread++}` })),
  );
  const host = createFakePluginHost({
    pluginId: "pipeline",
    sdk: {
      projects: {
        get: async () => (options?.project ?? project) as never,
      },
      threads: {
        spawn: spawn as never,
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
  return { host, store, service, spawn, classify, readIssue, publish, log };
}

function seed(
  store: ReturnType<typeof setup>["store"],
  options?: { id?: string; attachments?: CardAttachment[] },
) {
  return store.create({
    id: options?.id ?? "card_1",
    projectId: "proj_1",
    title: "Build it",
    body: "Body",
    attachments: options?.attachments ?? [],
    source: "cli",
  });
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
    const { store, service, classify } = setup();
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    await service.onThreadIdle(thread("lead"), text);

    expect(classify).not.toHaveBeenCalled();
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
    const { store, service, classify } = setup({ settings: { ...settings, jevApiKey: undefined } });
    seed(store);
    store.update("card_1", { leadThreadId: "lead", ownerRole: "lead" });

    await service.onThreadIdle(thread("lead"), "Question?");

    expect(classify).not.toHaveBeenCalled();
    expect(store.get("card_1")).toMatchObject({ needsUser: false, attentionUnknown: true });
  });

  it("preserves an explicit intake needs-you reason on idle", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", { intakeThreadId: "intake" });
    await service.report({ threadId: "intake", needsYou: "Which repository?" });
    const before = store.get("card_1");

    await service.onThreadIdle(thread("intake"), "Which repository?");

    expect(store.get("card_1")).toEqual(before);
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

  it("allows explicit-card reports from unrelated threads", async () => {
    const { store, service } = setup();
    seed(store);
    store.update("card_1", {
      intakeThreadId: "intake",
      leadThreadId: "lead",
      ownerRole: "lead",
    });

    await service.report({
      cardId: "card_1",
      threadId: "unrelated",
      issueUrl: "https://github.com/o/r/issues/2",
      working: true,
    });

    expect(store.get("card_1")).toMatchObject({
      issueUrl: "https://github.com/o/r/issues/2",
    });
    expect(store.history("card_1").at(-1)).toMatchObject({
      kind: "attention",
      threadId: "unrelated",
    });
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
    const { store, service } = setup();
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

    await service.move("card_1", "planning", "ui");
    expect(store.get("card_1")).toMatchObject({ ownerRole: "lead" });

    await service.move("card_1", "todo", "ui");
    expect(store.get("card_1")).toMatchObject({ ownerRole: "lead" });
  });

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

  it("retries the lead after planning takes ownership", async () => {
    let offline = true;
    const { store, service, spawn } = setup({
      spawn: async () => {
        if (offline) throw new Error("Mac offline");
        return makeThreadResponse({ id: "intake-retry" });
      },
    });
    seed(store);

    await service.launch("card_1", "intake");
    await service.move("card_1", "planning", "ui");
    expect(store.get("card_1")?.launchError).toContain("lead: no issue yet");
    await service.report({
      cardId: "card_1",
      issueUrl: "https://github.com/o/r/issues/1",
    });

    offline = false;
    await service.retry("card_1");

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(store.get("card_1")).toMatchObject({
      intakeThreadId: null,
      leadThreadId: "intake-retry",
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

  it("requires an issue before a lead launch and names the fix", async () => {
    const { store, service, spawn } = setup();
    seed(store);

    await service.launch("card_1", "lead");

    expect(store.get("card_1")?.launchError).toContain("bb pipeline report --card card_1 --issue <url>");
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
});

describe("startup pass", () => {
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
      reportSignal: "needs_you",
    });

    await service.onThreadActive(thread("lead", 0, { status: "active" }));

    expect(store.get("card_1")).toMatchObject({
      needsUser: false,
      attentionReason: null,
      attentionUnknown: false,
      threadError: null,
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
