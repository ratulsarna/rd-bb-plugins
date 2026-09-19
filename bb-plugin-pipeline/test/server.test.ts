import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
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
            ],
          }) as never,
      },
      threads: {
        spawn: async () => makeThreadResponse({ id: "intake" }),
        interactions: {
          list: options?.listInteractions ?? (async () => []),
        },
      },
    },
  });
  hosts.push(host);
  await plugin(host.bb);
  return host;
}

describe("plugin wiring", () => {
  it("creates a card through the CLI and exposes it through RPC", async () => {
    const host = await setup();

    const result = await host.harness.behavior.runCli(
      ["add", "--title", "Ship it", "--json"],
      { projectId: "proj_1" },
    );
    const cards = (await host.harness.behavior.callRpc("listCards", {
      projectId: "proj_1",
      includeDone: false,
    })) as { cards: unknown[] };

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ title: "Ship it", intakeThreadId: "intake" });
    expect(cards.cards).toHaveLength(1);
  });

  it("selects role-specific skills with an explicit empty tool set", async () => {
    const host = await setup();
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
    const host = await setup({
      listInteractions: async () => {
        throw new Error("thread not found");
      },
    });
    const added = await host.harness.behavior.runCli(
      ["add", "--title", "Deleted owner", "--json"],
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
