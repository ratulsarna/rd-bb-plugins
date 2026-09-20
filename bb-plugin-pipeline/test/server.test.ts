import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
  makeQueueEntry,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { Database } from "better-sqlite3";
import plugin from "../server";

const skillIds = [
  "pipeline",
  "pipeline-intake",
  "pipeline-plan",
  "pipeline-implement",
  "pipeline-close-out",
  "pipeline-debug",
];

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
      threads: {
        spawn: async () => makeThreadResponse({ id: "intake" }),
        queue: { list: async () => [] },
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
  it("reports queued child work through RPC and CLI and clears it when the message is cancelled", async () => {
    const { host } = await setup();
    const added = await host.harness.behavior.runCli(
      ["add", "--title", "Queued task", "--machine", "Work laptop", "--json"],
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
      .toMatchObject({ queuedCardIds: [card.id] });
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
      .toMatchObject({ queuedCardIds: [] });
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
      ["add", "--title", "Ship it", "--machine", "Work laptop", "--json"],
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

  it("selects role-specific skills with an explicit empty tool set", async () => {
    const { host } = await setup();
    const base = makePluginAgentConfigurationContext({
      origin: { kind: null, pluginId: "pipeline" },
    });

    await expect(
      host.harness.behavior.resolveAgentConfiguration({
        ...base,
        pluginMetadata: { role: "intake" },
      }),
    ).resolves.toMatchObject({ tools: [], skills: ["pipeline", "pipeline-intake"] });
    await expect(
      host.harness.behavior.resolveAgentConfiguration({
        ...base,
        pluginMetadata: { role: "lead" },
      }),
    ).resolves.toMatchObject({
      tools: [],
      skills: ["pipeline", "pipeline-plan", "pipeline-implement", "pipeline-close-out", "pipeline-debug"],
    });
  });

  it("shows card history when owner interactions are unavailable", async () => {
    const { host } = await setup({
      listInteractions: async () => {
        throw new Error("thread not found");
      },
    });
    const added = await host.harness.behavior.runCli(
      ["add", "--title", "Deleted owner", "--machine", "host_wt5difpwsy", "--json"],
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
