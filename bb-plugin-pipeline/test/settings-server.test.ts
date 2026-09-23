import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import plugin from "../server";
import { settingsViewSchema } from "../lib/settings";
import { integrationStatus } from "../lib/integrations";
import { createCardStore } from "../lib/store";
import { testCatalogProviders, testProviderModels } from "./sdk-fake";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { while (hosts.length) await hosts.pop()!.harness.lifecycle.dispose(); });
async function setup() {
  const host = createFakePluginHost({
    pluginId: "pipeline", settings: { jevApiKey: "test-secret", serviceTier: "fast" },
    agentSkillIds: ["pipeline", "pipeline-intake", "pipeline-plan", "pipeline-implement", "pipeline-close-out", "pipeline-debug"],
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: "machine", status: "connected" })] },
      projects: { get: async () => ({ id: "project", sources: [{ type: "local_path", hostId: "machine", path: "/repo" }] }) as never },
      providers: { list: async () => testCatalogProviders, models: async (args) => testProviderModels(args?.providerId) },
      threads: { listRunning: async () => [], queue: { list: async () => [] } },
    },
  });
  hosts.push(host);
  await plugin(host.bb);
  const read = async () => settingsViewSchema.parse(await host.harness.behavior.callRpc("getSettings", null));
  const write = (input: unknown) => host.harness.behavior.callRpc("updateSettings", input);
  return { ...host, read, write };
}

describe("Pipeline settings boundary", () => {
  it("uses saved secret configuration and patches only requested fields, including explicit tier/key clearing", async () => {
    const s = await setup();
    const initial = await s.read();
    expect(initial).toMatchObject({ jevApiKeyConfigured: true, values: { taskLimit: 2, rememberExecution: true, autoReviewFollowup: true } });
    expect(JSON.stringify(initial)).not.toContain("test-secret");
    await s.harness.behavior.setSettings({ leadModel: "claude-opus-4-7" });
    await s.write({ values: { taskLimit: 1, reviewRequestComment: "" } });
    expect(await s.read()).toMatchObject({ jevApiKeyConfigured: true, values: { taskLimit: 1, reviewRequestComment: "", lead: { model: "claude-opus-4-7" } } });
    const { serviceTier: _, ...intake } = initial.values.intake;
    const result = await s.write({ values: { intake }, jevApiKey: "replacement-secret" });
    expect(JSON.stringify(result)).not.toContain("replacement-secret");
    expect((await s.read()).values.intake.serviceTier).toBeUndefined();
    await s.write({ values: {}, jevApiKey: null });
    expect((await s.read()).jevApiKeyConfigured).toBe(false);
  });

  it("rejects invalid updates atomically across RPC and the shared settings writer", async () => {
    const s = await setup();
    for (const input of [
      { values: { taskLimit: 0, notificationsEnabled: false } },
      { values: { taskLimit: 1.5 } },
      { values: { jevThreshold: 0.4 } },
      { values: { unexpected: true } },
      { values: {}, jevApiKey: "   " },
    ]) await expect(s.write(input)).rejects.toThrow();
    await expect(s.harness.behavior.setSettings({ taskLimit: 0 })).rejects.toThrow();
    await expect(s.harness.behavior.setSettings({ jevThreshold: "not a number" })).rejects.toThrow();
    await expect(s.harness.behavior.setSettings({ model: " " })).rejects.toThrow();
    expect(await s.read()).toMatchObject({ jevApiKeyConfigured: true, values: { taskLimit: 2, notificationsEnabled: true } });
  });

  it("refreshes capacity and wakes durable waits for UI and CLI settings changes", async () => {
    const s = await setup();
    createCardStore(s.bb.storage.database()).create({ id: "card", projectId: "project", hostId: "machine", title: "Saved", body: "", attachments: [], startRequested: false, source: "ui" });
    await s.write({ values: { taskLimit: 3 } });
    expect(await s.harness.behavior.callRpc("listCards", { projectId: "project", includeDone: false }))
      .toMatchObject({ queue: [{ hostId: "machine", limit: 3 }] });
    expect(s.harness.inspection.recheckCount).toBe(1);
    await s.harness.behavior.setSettings({ taskLimit: 1 });
    expect(await s.harness.behavior.callRpc("listCards", { projectId: "project", includeDone: false }))
      .toMatchObject({ queue: [{ hostId: "machine", limit: 1 }] });
    expect(s.harness.inspection.recheckCount).toBe(2);
  });

  it("fixed defaults preserve one-off task choices and remembering can be restored", async () => {
    const s = await setup();
    await s.write({ values: { rememberExecution: false } });
    const intake = { providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "ultra" };
    const input = { projectId: "project", hostId: "machine", title: "Saved", body: "", attachments: [], intake, lead: intake, start: false };
    const first = await s.harness.behavior.callRpc("addCard", input);
    expect(first).toMatchObject({ intake, startRequested: false });
    expect((await s.read()).values.intake.model).toBe("claude-fable-5-1");
    await s.write({ values: { rememberExecution: true } });
    await s.harness.behavior.callRpc("addCard", input);
    expect((await s.read()).values.intake).toEqual(intake);
  });
});

describe("integration status", () => {
  it("keeps independent results and reports configuration without claiming a Jev connection", async () => {
    const list = vi.fn(async () => ({ plugins: [{ id: "notify", enabled: true, status: "running" }] }));
    const sdk = { plugins: { list } } as unknown as PluginBbSdk;
    const gh = vi.fn(async () => "example-user\n");
    expect(await integrationStatus(sdk, true, gh)).toEqual({
      github: { available: true, detail: "Authenticated as example-user" },
      jev: { configured: true }, notify: { available: true, detail: "Running" },
    });
    gh.mockRejectedValueOnce(new Error("token=do-not-expose"));
    list.mockResolvedValueOnce({ plugins: [{ id: "notify", enabled: false, status: "stopped" }] });
    const failed = await integrationStatus(sdk, true, gh);
    expect(failed).toMatchObject({ github: { available: false }, jev: { configured: true }, notify: { available: false, detail: "Disabled" } });
    expect(JSON.stringify(failed)).not.toContain("do-not-expose");
  });
});
