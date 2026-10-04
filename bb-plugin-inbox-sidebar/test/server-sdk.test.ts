import { expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { boardRpcContract } from "../server";

type ExecutionOptions = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["defaultExecutionOptions"]>>;
const cases: { options: ExecutionOptions; unavailableProvider?: boolean }[] = [
  { options: null },
  { options: null, unavailableProvider: true },
  { options: {
    model: "test-model",
    permissionMode: "full",
    reasoningLevel: "high",
    serviceTier: "priority",
    source: "client/thread/start",
  } },
];

it.each(cases)("serializes restart seeds with execution options: $options, unavailable provider: $unavailableProvider", async ({ options, unavailableProvider }) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "inbox-sidebar" });
  harness.sdk.stub("threads.get", async () => makeThreadResponse({
    id: "thread-sam",
    projectId: "project-assistants",
    environmentId: "environment-sam",
    title: "Sam",
  }));
  harness.sdk.stub("threads.defaultExecutionOptions", async () => {
    if (unavailableProvider) throw new Error("source provider no longer registered");
    return options;
  });
  harness.sdk.stub("environments.get", async () => ({
    id: "environment-sam",
    projectId: "project-assistants",
    hostId: "host-target",
    path: "/test/assistants/sam",
  }));
  harness.sdk.stub("projects.get", async () => ({
    name: "assistants",
    sources: [{ hostId: "host-target", path: "/test/assistants" }],
  }));
  harness.sdk.stub("projects.list", async () => [{
    name: "ObsidianVault",
    sources: [{ hostId: "host-target", path: "/test/vault" }],
  }]);
  harness.sdk.stub("plugins.callRpc", async ({ pluginId, method }) => {
    if (pluginId !== "private-sync") throw new Error("No automations fixture");
    if (method === "machineDirectory") return [{ hostId: "host-target", name: "Target", connected: true }];
    return { enabled: false, paused: false, configError: null, folders: [
      { id: "assistants", nodes: [{ hostId: "host-target", path: "/test/assistants", ready: false, phase: "disabled", error: null }] },
      { id: "vault", nodes: [{ hostId: "host-target", path: "/test/vault", ready: false, phase: "disabled", error: null }] },
    ] };
  });
  plugin(bb);

  try {
    const seeds = boardRpcContract.assistantSeeds.output.parse(
      await harness.behavior.callRpc("assistantSeeds", { threadId: "thread-sam" }),
    );
    expect(seeds).toMatchObject({
      identity: "project-assistants:sam",
      vaultPath: "/test/vault",
      homePath: "/test/assistants/sam",
      homes: [{ name: "sam", path: "/test/assistants/sam" }],
    });
    if (options === null) {
      for (const key of ["model", "permissionMode", "reasoningLevel", "serviceTier"]) {
        expect(Object.keys(seeds)).not.toContain(key);
      }
    } else {
      expect(seeds).toMatchObject({
        model: options.model,
        permissionMode: options.permissionMode,
        reasoningLevel: options.reasoningLevel,
        serviceTier: options.serviceTier,
      });
    }
  } finally {
    await harness.lifecycle.dispose();
  }
});
