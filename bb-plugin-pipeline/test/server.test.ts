import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
  makeQueueEntry,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { Database } from "better-sqlite3";
import plugin from "../server";
import { createCardStore, type Card } from "../lib/store";
import { makeCheckoutEnvironment, testCatalogProviders, testProviderModels } from "./sdk-fake";

const skillIds = ["pipeline"];

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

async function setup(options?: {
  listInteractions?: () => Promise<unknown[]>;
  secondCheckout?: boolean;
}) {
  const host = createFakePluginHost({
    pluginId: "pipeline",
    agentSkillIds: skillIds,
    sdk: {
      plugins: {
        callRpc: async ({ outputSchema }) => outputSchema.parse({ delivery: "held" }),
      },
      projects: {
        list: async () => [],
        get: async () =>
          ({
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
                hostId: "host_wt5difpwsy",
                path: "/repo",
                isDefault: true,
                createdAt: 1,
                updatedAt: 1,
              },
              ...(options?.secondCheckout
                ? [
                    {
                      id: "source_2",
                      projectId: "proj_1",
                      type: "local_path",
                      hostId: "host_no_checkout",
                      path: "/repo-2",
                      isDefault: false,
                      createdAt: 1,
                      updatedAt: 1,
                    },
                  ]
                : []),
            ],
          }) as never,
      },
      hosts: {
        list: async () =>
          [
            makeHostResponse({
              id: "host_wt5difpwsy",
              name: "Work laptop",
              status: "connected",
            }),
            makeHostResponse({
              id: "host_no_checkout",
              name: "Headless box",
              status: "connected",
            }),
          ] as never,
      },
      providers: {
        list: async () => testCatalogProviders,
        models: async (input) => testProviderModels(input?.providerId),
      },
      environments: {
        list: async (input) => [makeCheckoutEnvironment({
          projectId: input?.projectId, hostId: input?.hostId, path: input?.path,
        })],
      },
      threads: {
        listRunning: async () => [],
        spawn: async () => makeThreadResponse({ id: "intake" }),
        queue: { list: async () => [] },
        queuedMessages: { list: async ({ threadId }) => (await host.bb.sdk.threads.queue.list()).filter((entry) => entry.threadId === threadId) },
        interactions: {
          list: options?.listInteractions ?? (async () => []),
        },
      },
    },
  });
  hosts.push(host);
  await plugin(host.bb);
  return { host, db: host.bb.storage.database() as Database };
}

function seedLegacyCard(db: Database, id = "card_legacy"): void {
  db.prepare(
    `INSERT INTO cards (id, project_id, title, "column", created_at, updated_at)
     VALUES (?, 'proj_1', 'Legacy card', 'backlog', 1, 1)`,
  ).run(id);
}

describe("plugin wiring", () => {
  it("recovers a created intake after reload without starting other saved tasks", async () => {
    const { host, db } = await setup();
    const input = {
      projectId: "proj_1", hostId: "host_wt5difpwsy", title: "Later",
      body: "", attachments: [], start: false,
    };
    const interrupted = await host.harness.behavior.callRpc("addCard", input) as Card;
    const untouched = await host.harness.behavior.callRpc("addCard", input) as Card;
    createCardStore(db).update(interrupted.id, { startRequested: true }, {
      kind: "start_requested", source: "ui",
    });
    const orphan = makeThreadResponse({
      id: "orphan-intake", projectId: "proj_1", status: "starting", originPluginId: "pipeline",
    });
    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    reloaded.harness.inspection.sdk.stub("threads.list", async () => [orphan] as never);
    reloaded.harness.inspection.sdk.stub("threads.getPluginMetadata", async () => ({
      cardId: interrupted.id, role: "intake", hostId: "host_wt5difpwsy",
    }));
    reloaded.harness.inspection.sdk.stub("threads.get", async () => orphan);
    const startup = reloaded.harness.behavior.runService("startup-pass");
    try {
      await vi.waitFor(async () => {
        expect(await reloaded.harness.behavior.callRpc("showCard", { cardId: interrupted.id }))
          .toMatchObject({ card: { intakeThreadId: orphan.id, launchError: null } });
      });
      await reloaded.harness.behavior.callRpc("startCard", { cardId: interrupted.id });
      expect(await reloaded.harness.behavior.callRpc("showCard", { cardId: untouched.id }))
        .toMatchObject({ card: { startRequested: false, intakeThreadId: null }, queued: false });
      expect(reloaded.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
      expect(reloaded.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    } finally {
      startup.controller.abort();
      await startup.done;
    }
  });

  it("saves through RPC without launching, then starts once through concurrent UI and CLI requests", async () => {
    const { host } = await setup();
    const saved = await host.harness.behavior.callRpc("addCard", {
      projectId: "proj_1", hostId: "host_wt5difpwsy", title: "Later", body: "Keep context",
      attachments: [{ path: "/uploads/design.png", filename: "design.png", isImage: true }], start: false,
    }) as Card;
    expect(saved).toMatchObject({ startRequested: false, intakeThreadId: null, launchError: null });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    const listed = await host.harness.behavior.runCli(["list"], { projectId: "proj_1" });
    expect(listed.stdout).toContain("not started");
    const shown = await host.harness.behavior.callRpc("showCard", { cardId: saved.id }) as { card: Card; queued: boolean };
    expect(shown).toMatchObject({ card: { startRequested: false }, queued: false });

    const [started, cli] = await Promise.all([
      host.harness.behavior.callRpc("startCard", { cardId: saved.id }),
      host.harness.behavior.runCli(["start", saved.id, "--json"]),
    ]);
    expect(started).toMatchObject({ startRequested: true, intakeThreadId: "intake" });
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ startRequested: true, intakeThreadId: "intake" });
    const calls = host.harness.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ input: expect.arrayContaining([{ type: "localImage", path: "/uploads/design.png" }]) });
    await host.harness.behavior.callRpc("startCard", { cardId: saved.id });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("saves CLI add by default, starts with --start, and rejects unknown flags", async () => {
    const { host, db } = await setup();
    const args = ["add", "--title", "Later", "--machine", "Work laptop", "--json"];
    const saved = await host.harness.behavior.runCli(args, { projectId: "proj_1" });
    expect(saved.exitCode).toBe(0);
    const card = JSON.parse(saved.stdout) as Card;
    expect(card).toMatchObject({ column: "backlog", startRequested: false, intakeThreadId: null });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    const unsupported = await host.harness.behavior.runCli([...args, "--no-start"], { projectId: "proj_1" });
    expect(unsupported.exitCode).toBe(1);
    expect(unsupported.stderr).toContain("unknown option --no-start");
    for (const argv of [["start", card.id, "--start"], ["start"], ["start", card.id, "extra"]]) {
      expect((await host.harness.behavior.runCli(argv)).exitCode).toBe(1);
    }
    await expect(host.harness.behavior.callRpc("addCard", {
      projectId: "proj_1", hostId: "host_wt5difpwsy", title: "Invalid", body: "", attachments: [], start: "false",
    })).rejects.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM cards").get()).toEqual({ n: 1 });
    const added = await host.harness.behavior.runCli([...args, "--start"], { projectId: "proj_1" });
    expect(added.exitCode).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({ column: "todo", startRequested: true, intakeThreadId: "intake" });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("coordinates RPC pause, owner acknowledgement, real activity release and CLI resume", async () => {
    const { host, db } = await setup();
    seedLegacyCard(db);
    db.prepare("UPDATE cards SET intake_thread_id = 'intake' WHERE id = 'card_legacy'").run();
    let occupied = true;
    const thread = makeThreadResponse({ id: "intake", projectId: "proj_1", status: "active" });
    host.harness.inspection.sdk.stub("threads.get", async () => thread);
    host.harness.inspection.sdk.stub("threads.listRunning", async () => occupied ? [{ id: "intake", hostId: "host_wt5difpwsy" }] : []);
    host.harness.inspection.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
    const paused = await host.harness.behavior.callRpc("pauseCard", { cardId: "card_legacy" }) as Card;
    expect(paused).toMatchObject({ runState: "pause_requested", controlError: null });
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    const send = host.harness.inspection.sdk.callsTo("threads.send")[0]![0] as Parameters<typeof host.bb.sdk.threads.send>[0];
    expect(send).toMatchObject({ threadId: "intake", mode: "steer" });
    await host.harness.behavior.emitThreadEvent("message.cancelled", { entry: makeQueueEntry({
      threadId: "intake", content: send.input,
    }) });
    expect((await host.harness.behavior.callRpc("showCard", { cardId: "card_legacy" }) as { card: Card }).card.controlError).toContain("cancelled");
    expect((await host.harness.behavior.runCli(["pause", "card_legacy"])).exitCode).toBe(0);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
    expect((await host.harness.behavior.runCli(["report", "--card", "card_legacy", "--needs-you", "Safe to pause"])).exitCode).toBe(0);
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    expect((await host.harness.behavior.runCli(["move", "card_legacy", "todo"])).exitCode).toBe(1);
    const ack = ["report", "--card", "card_legacy", "--paused", paused.pauseRequestId!, "--json"];
    expect((await host.harness.behavior.runCli(ack, { threadId: "worker" })).exitCode).toBe(1);
    const acknowledged = await host.harness.behavior.runCli(ack, { threadId: "intake" });
    expect(acknowledged.exitCode).toBe(0);
    expect(JSON.parse(acknowledged.stdout).runState).toBe("pausing");
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...thread, status: "idle" }, lastAssistantText: null });
    expect((await host.harness.behavior.callRpc("showCard", { cardId: "card_legacy" }) as { card: Card }).card.runState).toBe("pausing");
    occupied = false;
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...thread, status: "idle" }, lastAssistantText: null });
    expect((await host.harness.behavior.callRpc("showCard", { cardId: "card_legacy" }) as { card: Card }).card.runState).toBe("paused");
    const resumed = await host.harness.behavior.runCli(["resume", "card_legacy", "--json"]);
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ runState: "running", pauseRequestId: null });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(3);
    expect((await host.harness.behavior.runCli(ack, { threadId: "intake" })).exitCode).toBe(1);
  });

  it("resumes a cancelled pending kickoff in place, and replaces an owner deleted before reconciliation", async () => {
    const { host } = await setup();
    const card = await host.harness.behavior.callRpc("addCard", {
      projectId: "proj_1", hostId: "host_wt5difpwsy", title: "Recover me", body: "Keep this context",
      attachments: [{ path: "uploads/example.png", filename: "example.png", isImage: true }], start: true,
    }) as Card;
    host.harness.inspection.sdk.stub("threads.listRunning", async () => []);
    host.harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "intake", status: "pending", queuedMessageCount: 0 }));
    host.harness.inspection.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
    expect((await host.harness.behavior.callRpc("pauseCard", { cardId: card.id }) as Card).runState).toBe("paused");
    const resumed = await host.harness.behavior.callRpc("resumeCard", { cardId: card.id }) as Card;
    expect(resumed).toMatchObject({ runState: "running", intakeThreadId: "intake", launchError: null });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("threads.send")[0]![0]).toMatchObject({
      threadId: "intake", input: (host.harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Parameters<typeof host.bb.sdk.threads.spawn>[0]).input,
    });
    await host.harness.behavior.callRpc("pauseCard", { cardId: card.id });
    host.harness.inspection.sdk.stub("threads.get", async () => { throw Object.assign(new Error("gone"), { status: 404 }); });
    host.harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "replacement" }));
    const recovered = await host.harness.behavior.callRpc("resumeCard", { cardId: card.id }) as Card;
    expect(recovered).toMatchObject({ runState: "running", intakeThreadId: "replacement", controlError: null });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });

  it("sends attention through Notify without making delivery a task dependency", async () => {
    const { host, db } = await setup();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    host.harness.inspection.sdk.stub("plugins.callRpc", async () => {
      await blocked;
      return { delivery: "held" };
    });
    seedLegacyCard(db);
    db.prepare("UPDATE cards SET intake_thread_id = 'intake' WHERE id = 'card_legacy'").run();
    try {
      const result = await host.harness.behavior.runCli(
        ["report", "--card", "card_legacy", "--needs-you", "Choose the release target", "--json"],
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ needsUser: true, attentionReason: "Choose the release target" });
      const repeated = await host.harness.behavior.runCli(
        ["report", "--card", "card_legacy", "--needs-you", "Choose the release target"],
      );
      expect(repeated.exitCode).toBe(0);
      expect(repeated.stdout).toContain("user-facing chat reply");
      expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
      expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
      expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")[0]![0]).toMatchObject({
        pluginId: "notify", method: "send", input: {
          title: "Pipeline: Legacy card", message: "Choose the release target",
          projectId: "proj_1", threadId: "intake",
        },
      });
    } finally {
      finish();
    }

    await host.harness.behavior.runCli(["report", "--card", "card_legacy", "--working"]);
    host.harness.inspection.sdk.stub("plugins.callRpc", async () => { throw new Error("Notify is disabled"); });
    const result = await host.harness.behavior.runCli(
      ["report", "--card", "card_legacy", "--needs-you", "Try again", "--json"],
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ needsUser: true, attentionReason: "Try again" });
    await vi.waitFor(() => expect(host.harness.inspection.logEntries).toContainEqual(
      expect.objectContaining({ level: "warn", message: expect.stringContaining("Notify is disabled") }),
    ));
  });

  it("notifies pending owner questions but ignores unrelated and former-owner threads", async () => {
    const { host, db } = await setup();
    seedLegacyCard(db);
    db.prepare("UPDATE cards SET intake_thread_id = 'intake', lead_thread_id = 'lead', owner_role = 'lead' WHERE id = 'card_legacy'").run();
    const ask = (threadId: string) => host.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: makeThreadResponse({ id: threadId, projectId: "proj_1", status: "active" }),
      interaction: {
        id: `question-${threadId}`, threadId, turnId: null,
        createdAt: 1, resolvedAt: null, status: "pending", statusReason: null,
        origin: { kind: "plugin", pluginId: "questions", rendererId: "question" },
        payload: { kind: "plugin", title: "Choose a release", data: {} }, resolution: null,
      },
    });
    await ask("unrelated");
    await ask("intake");
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    await ask("lead");
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")[0]![0]).toMatchObject({
      input: { threadId: "lead", message: "Question waiting for you" },
    });
    db.prepare("UPDATE cards SET needs_user = 1 WHERE id = 'card_legacy'").run();
    await ask("lead");
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);

    db.prepare("UPDATE cards SET needs_user = 0, \"column\" = 'done' WHERE id = 'card_legacy'").run();
    await ask("lead");
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    await host.harness.behavior.callRpc("moveCard", { cardId: "card_legacy", column: "implementing" });
    await ask("lead");
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(2);
  });

  it("keeps completed cards quiet for reports and failures and notifies again after reopening", async () => {
    const { host, db } = await setup();
    seedLegacyCard(db);
    db.prepare("UPDATE cards SET lead_thread_id = 'lead', owner_role = 'lead', \"column\" = 'done' WHERE id = 'card_legacy'").run();
    const report = (signal: string[]) => host.harness.behavior.runCli([
      "report", "--card", "card_legacy", ...signal,
    ]);
    const fail = () => host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "lead", projectId: "proj_1", status: "error" }),
      error: "provider stopped",
    });

    expect((await report(["--needs-you", "Review this again"])).exitCode).toBe(0);
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    expect((await report(["--working"])).exitCode).toBe(0);
    await fail();
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);

    await host.harness.behavior.callRpc("moveCard", { cardId: "card_legacy", column: "implementing" });
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "lead", projectId: "proj_1", status: "active" }),
    });
    await fail();
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")[0]![0]).toMatchObject({
      input: { threadId: "lead", message: "thread failed: provider stopped" },
    });
  });

  it("inherits cleared lead settings and accepts new role selections", async () => {
    const { host } = await setup();
    await host.harness.behavior.setSettings({
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "ultra",
      serviceTier: "fast",
      leadProviderId: "   ",
      leadModel: "",
    });
    const intake = {
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "ultra",
      serviceTier: "fast",
    };
    expect(await host.harness.behavior.callRpc("executionDefaults", null)).toEqual({
      intake,
      lead: intake,
    });

    const result = await host.harness.behavior.runCli(
      ["add", "--title", "Choose roles", "--machine", "Work laptop",
        "--lead-provider", "pi", "--lead-model", "zai/glm-5.3-flash",
        "--lead-reasoning", "high", "--json"],
      { projectId: "proj_1" },
    );
    expect(result.exitCode).toBe(0);
    const lead = { providerId: "pi", model: "zai/glm-5.3-flash", reasoningLevel: "high" };
    expect(JSON.parse(result.stdout)).toMatchObject({ intake, lead, launchError: null });
    expect(await host.harness.behavior.callRpc("executionDefaults", null)).toEqual({ intake, lead });
  });

  it("remembers UI selections across reload and lets CLI override each role independently", async () => {
    const { host } = await setup();
    const intake = { providerId: "pi", model: "zai/glm-5.3-flash", reasoningLevel: "none" };
    const lead = { providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "ultra", serviceTier: "fast" };
    const added = await host.harness.behavior.callRpc("addCard", {
      projectId: "proj_1", hostId: "host_wt5difpwsy", title: "Separate roles",
      body: "", attachments: [], intake, lead,
    }) as Card;
    expect(added).toMatchObject({ intake, lead });

    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    expect(await reloaded.harness.behavior.callRpc("executionDefaults", null)).toEqual({ intake, lead });
    const inherited = await reloaded.harness.behavior.runCli(
      ["add", "--title", "Remembered roles", "--machine", "Work laptop", "--json"],
      { projectId: "proj_1" },
    );
    expect(inherited.exitCode).toBe(0);
    expect(JSON.parse(inherited.stdout)).toMatchObject({ intake, lead });

    const changed = await reloaded.harness.behavior.runCli([
      "add", "--title", "Updated roles", "--machine", "Work laptop", "--json",
      "--intake-provider", "codex", "--intake-model", "gpt-5.6-luna", "--intake-reasoning", "medium", "--intake-service-tier", "fast",
      "--lead-provider", "claude-code", "--lead-model", "claude-fable-5-1", "--lead-reasoning", "high",
    ], { projectId: "proj_1" });
    expect(changed.exitCode).toBe(0);
    const nextIntake = { providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "medium", serviceTier: "fast" };
    const nextLead = { providerId: "claude-code", model: "claude-fable-5-1", reasoningLevel: "high" };
    expect(await reloaded.harness.behavior.callRpc("executionDefaults", null)).toEqual({ intake: nextIntake, lead: nextLead });
    expect(await reloaded.harness.behavior.callRpc("showCard", { cardId: added.id })).toMatchObject({ card: { intake, lead } });

    const partial = await reloaded.harness.behavior.runCli([
      "add", "--title", "One override", "--machine", "Work laptop", "--intake-reasoning", "low", "--intake-service-tier", "default", "--json",
    ], { projectId: "proj_1" });
    expect(partial.exitCode).toBe(0);
    expect(JSON.parse(partial.stdout)).toMatchObject({ intake: { ...nextIntake, reasoningLevel: "low", serviceTier: "default" }, lead: nextLead });
  });

  it("rejects malformed role options without changing cards or remembered settings", async () => {
    const { host, db } = await setup();
    const before = await host.harness.behavior.callRpc("executionDefaults", null);
    for (const options of [["--intake-reasoning", "impossible"], ["--lead-model", "   "]]) {
      const result = await host.harness.behavior.runCli(
        ["add", "--title", "Bad selection", "--machine", "Work laptop", ...options],
        { projectId: "proj_1" },
      );
      expect(result.exitCode).toBe(1);
    }
    const misplaced = await host.harness.behavior.runCli(["list", "--lead-model", "gpt-5.6-sol"], { projectId: "proj_1" });
    expect(misplaced.exitCode).toBe(1);
    expect(misplaced.stderr).toContain("only accepted by add");
    await expect(host.harness.behavior.callRpc("addCard", {
      projectId: "proj_1", hostId: "host_wt5difpwsy", title: "Bad RPC",
      body: "", attachments: [], lead: { reasoningLevel: "impossible" },
    })).rejects.toThrow("rpc input validation failed");
    expect(db.prepare("SELECT count(*) AS count FROM cards").get()).toEqual({ count: 0 });
    expect(await host.harness.behavior.callRpc("executionDefaults", null)).toEqual(before);
  });

  it("rejects catalog-invalid CLI and RPC selections before persistence", async () => {
    const { host, db } = await setup();
    const before = await host.harness.behavior.callRpc("executionDefaults", null);

    const unknownProvider = await host.harness.behavior.runCli(
      [
        "add",
        "--title",
        "Unknown provider",
        "--machine",
        "Work laptop",
        "--intake-provider",
        "missing",
        "--intake-model",
        "missing-model",
      ],
      { projectId: "proj_1" },
    );
    expect(unknownProvider.exitCode).toBe(1);
    expect(unknownProvider.stderr).toContain(
      'intake provider "missing" is not installed on machine "Work laptop" (host_wt5difpwsy)',
    );

    await expect(
      host.harness.behavior.callRpc("addCard", {
        projectId: "proj_1",
        hostId: "host_wt5difpwsy",
        title: "Unavailable lead model",
        body: "",
        attachments: [],
        lead: {
          providerId: "pi",
          model: "zai/missing",
          reasoningLevel: "high",
        },
      }),
    ).rejects.toThrow(
      'lead model "zai/missing" is unavailable for provider "pi" on machine "Work laptop" (host_wt5difpwsy)',
    );

    expect(db.prepare("SELECT count(*) AS count FROM cards").get()).toEqual({
      count: 0,
    });
    expect(await host.harness.behavior.callRpc("executionDefaults", null)).toEqual(before);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("surfaces a cancelled kickoff and clears that attention when the same pending thread queues again", async () => {
    const { host } = await setup();
    const added = await host.harness.behavior.runCli(
      ["add", "--title", "Cancelled task", "--machine", "Work laptop", "--start", "--json"],
      { projectId: "proj_1" },
    );
    const card = JSON.parse(added.stdout) as { id: string };
    let thread = makeThreadResponse({ id: "intake", projectId: "proj_1", status: "pending", queuedMessageCount: 0 });
    host.harness.inspection.sdk.stub("threads.get", async () => thread);
    const entry = makeQueueEntry({ threadId: thread.id });

    await host.harness.behavior.emitThreadEvent("message.cancelled", { entry });
    expect(await host.harness.behavior.callRpc("showCard", { cardId: card.id }))
      .toMatchObject({ card: { intakeThreadId: "intake", needsUser: true, launchError: expect.stringContaining("cancelled") } });

    thread = { ...thread, queuedMessageCount: 1 };
    await host.harness.behavior.emitThreadEvent("message.queued", { entry });
    expect(await host.harness.behavior.callRpc("showCard", { cardId: card.id }))
      .toMatchObject({ card: { intakeThreadId: "intake", needsUser: false, launchError: null } });
  });

  it("reports queued child work through RPC and CLI and clears it when the message is cancelled", async () => {
    const { host } = await setup();
    const added = await host.harness.behavior.runCli(
      ["add", "--title", "Queued task", "--machine", "Work laptop", "--start", "--json"],
      { projectId: "proj_1" },
    );
    const card = JSON.parse(added.stdout) as { id: string };
    const worker = makeThreadResponse({ id: "worker", projectId: "proj_1", parentThreadId: "intake" });
    const entry = makeQueueEntry({ threadId: "worker" });
    let queued = true;
    host.harness.inspection.sdk.stub("threads.queue.list", async () => queued ? [entry] : []);
    host.harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      threadId === "worker" ? worker : makeThreadResponse({ id: "intake", projectId: "proj_1" }),
    );

    expect(await host.harness.behavior.callRpc("listCards", { projectId: "proj_1", includeDone: false }))
      .toMatchObject({ queue: [expect.objectContaining({ waiting: [expect.objectContaining({ cardId: card.id })] })] });
    expect(await host.harness.behavior.callRpc("showCard", { cardId: card.id }))
      .toMatchObject({ queued: true });
    const listed = await host.harness.behavior.runCli(["list", "--json"], { projectId: "proj_1" });
    expect(JSON.parse(listed.stdout)).toMatchObject([{ id: card.id, queued: true }]);
    const shown = await host.harness.behavior.runCli(["show", card.id, "--json"], { projectId: "proj_1" });
    expect(JSON.parse(shown.stdout)).toMatchObject({ queued: true });

    queued = false;
    await host.harness.behavior.emitThreadEvent("message.cancelled", { entry });
    expect(host.harness.inspection.realtimeSignals.at(-1)).toMatchObject({ payload: { projectId: "proj_1" } });
    expect(await host.harness.behavior.callRpc("listCards", { projectId: "proj_1", includeDone: false }))
      .toMatchObject({ queue: [expect.objectContaining({ waiting: [] })] });
  });

  it("wakes the queue when work ends, without scheduling another drain every time a message requeues", async () => {
    const { host } = await setup();
    const thread = makeThreadResponse({ id: "ordinary", projectId: "proj_1", status: "idle" });
    host.harness.inspection.sdk.stub("threads.get", async () => thread);
    const before = host.harness.inspection.recheckCount;
    await host.harness.behavior.emitThreadEvent("message.queued", { entry: makeQueueEntry({ threadId: thread.id }) });
    expect(host.harness.inspection.recheckCount).toBe(before);
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    expect(host.harness.inspection.recheckCount).toBe(before + 1);
    await host.harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 2 });
    expect(host.harness.inspection.recheckCount).toBe(before + 2);
  });

  it("creates a card through the CLI and exposes it through RPC", async () => {
    const { host } = await setup();

    const result = await host.harness.behavior.runCli(
      ["add", "--title", "Ship it", "--machine", "Work laptop", "--start", "--json"],
      { projectId: "proj_1" },
    );
    const cards = (await host.harness.behavior.callRpc("listCards", {
      projectId: "proj_1",
      includeDone: false,
    })) as { cards: unknown[] };

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      title: "Ship it",
      hostId: "host_wt5difpwsy",
      intakeThreadId: "intake",
    });
    expect(cards.cards).toHaveLength(1);
  });

  it("rejects add without an explicit machine", async () => {
    const { host } = await setup();

    const result = await host.harness.behavior.runCli(
      ["add", "--title", "Ship it"],
      { projectId: "proj_1" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("add requires --machine");
  });

  it("rejects an unknown machine name without creating a card", async () => {
    const { host } = await setup();

    const result = await host.harness.behavior.runCli(
      ["add", "--title", "Ship it", "--machine", "Ghost rig"],
      { projectId: "proj_1" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown machine "Ghost rig"');
    expect(
      (await host.harness.behavior.callRpc("listCards", {
        projectId: "proj_1",
        includeDone: true,
      })) as { cards: unknown[] },
    ).toMatchObject({ cards: [] });
  });

  it("rejects --machine on commands that do not accept it", async () => {
    const { host } = await setup();

    const result = await host.harness.behavior.runCli(
      ["list", "--machine", "host_wt5difpwsy"],
      { projectId: "proj_1" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--machine is only accepted by add and set-machine");
  });

  it("requires hostId on the addCard RPC", async () => {
    const { host } = await setup();

    await expect(
      host.harness.behavior.callRpc("addCard", {
        projectId: "proj_1",
        title: "Ship it",
        body: "",
        attachments: [],
      }),
    ).rejects.toThrow("rpc input validation failed");
  });

  it("lists only machines with a local project checkout", async () => {
    const { host } = await setup();

    await expect(
      host.harness.behavior.callRpc("listMachines", { projectId: "proj_1" }),
    ).resolves.toEqual({
      machines: [
        { id: "host_wt5difpwsy", name: "Work laptop", status: "connected" },
      ],
    });
  });

  it("rejects setMachine on a card that already has a machine", async () => {
    const { host, db } = await setup({ secondCheckout: true });
    seedLegacyCard(db);
    await host.harness.behavior.callRpc("setMachine", {
      cardId: "card_legacy",
      hostId: "host_wt5difpwsy",
    });

    await expect(
      host.harness.behavior.callRpc("setMachine", {
        cardId: "card_legacy",
        hostId: "host_no_checkout",
      }),
    ).rejects.toThrow("already assigned to machine host_wt5difpwsy");
  });

  it("rejects setMachine for a machine without a project checkout", async () => {
    const { host, db } = await setup();
    seedLegacyCard(db);

    await expect(
      host.harness.behavior.callRpc("setMachine", {
        cardId: "card_legacy",
        hostId: "host_no_checkout",
      }),
    ).rejects.toThrow('unknown machine "host_no_checkout"');
  });

  it("assigns a legacy card through the set-machine CLI and exposes the machine", async () => {
    const { host, db } = await setup();
    seedLegacyCard(db);

    const result = await host.harness.behavior.runCli(
      ["set-machine", "card_legacy", "--machine", "Work laptop", "--json"],
      { projectId: "proj_1" },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "card_legacy",
      hostId: "host_wt5difpwsy",
    });
    const shown = (await host.harness.behavior.callRpc("showCard", {
      cardId: "card_legacy",
    })) as { card: { hostId: string | null } };
    expect(shown.card.hostId).toBe("host_wt5difpwsy");
  });

  it("exposes only the board skill without injected instructions for ordinary, intake, and lead threads", async () => {
    const { host } = await setup();
    for (const role of [undefined, "intake", "lead"]) {
      await expect(
        host.harness.behavior.resolveAgentConfiguration(
          makePluginAgentConfigurationContext({
            origin: { kind: null, pluginId: role === undefined ? null : "pipeline" },
            pluginMetadata: role === undefined ? {} : { role },
          }),
        ),
      ).resolves.toEqual({ tools: [], skills: skillIds, instructions: null });
    }
  });

  it("shows card history when owner interactions are unavailable", async () => {
    const { host } = await setup({
      listInteractions: async () => {
        throw new Error("thread not found");
      },
    });
    const added = await host.harness.behavior.runCli(
      ["add", "--title", "Deleted owner", "--machine", "host_wt5difpwsy", "--start", "--json"],
      { projectId: "proj_1" },
    );
    const card = JSON.parse(added.stdout) as { id: string };

    const shown = await host.harness.behavior.runCli(
      ["show", card.id, "--json"],
      { projectId: "proj_1" },
    );

    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      card: { id: card.id },
      interactions: [],
      interactionsNote: "Could not load interactions for intake: thread not found",
    });
  });
});
