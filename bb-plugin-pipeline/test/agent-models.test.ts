import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentModels, writeAgentModels } from "@ratulsarna/agent-models";
import plugin from "../server";
import { agentModelSettingsSchema } from "../lib/agent-models";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.unstubAllEnvs();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pipeline-agent-models-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  vi.stubEnv("AGENT_MODELS_CONFIG", path);
  const host = createFakePluginHost({ pluginId: "pipeline", agentSkillIds: ["pipeline"] });
  cleanup.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  const get = async () => agentModelSettingsSchema.parse(await host.harness.behavior.callRpc("getAgentModels", null));
  const save = (input: unknown) => host.harness.behavior.callRpc("updateAgentModels", input);
  const instructions = () => host.harness.inspection.registrations.instructionProvider!({ threadId: "thr_1", projectId: "proj_1" });
  return { root, path, host, get, save, instructions };
}

describe("shared agent model RPC", () => {
  it("serves defaults without a file, saves the same choices the standalone reader sees, and rejects stale saves", async () => {
    const s = await setup();
    const initial = await s.get();
    expect(initial.source).toBe("defaults");
    await expect(lstat(s.path)).rejects.toMatchObject({ code: "ENOENT" });
    const models = {
      review: { ...initial.models.review, second: { providerId: "pi", model: "zai/custom-reviewer", reasoningLevel: "medium" } },
      subagents: { ...initial.models.subagents, qa: { providerId: "claude-code", model: "claude-sonnet-5", reasoningLevel: "high" } },
    };
    await s.save({ models, expectedRevision: initial.revision });
    expect(readAgentModels().models).toEqual(models);
    await expect(s.save({ models: initial.models, expectedRevision: initial.revision })).rejects.toThrow(/changed/);
    expect((await s.get()).models).toEqual(models);
    expect(s.host.harness.inspection.sdk.calls).toEqual([]);
  });

  it("preserves a synced symlink and refuses corrupt data or invalid requests", async () => {
    const s = await setup();
    const target = join(s.root, "synced.json");
    const initial = readAgentModels(target);
    await writeAgentModels(initial.models, initial.revision, target);
    await symlink(target, s.path);
    const before = await s.get();
    await s.save({ models: { ...before.models, review: { ...before.models.review, first: { providerId: "codex", model: "custom", reasoningLevel: "high" } } }, expectedRevision: before.revision });
    expect((await lstat(s.path)).isSymbolicLink()).toBe(true);
    expect(readAgentModels(target).models.review.first.model).toBe("custom");
    const current = await s.get();
    await expect(s.save({ models: { ...current.models, subagents: { ...current.models.subagents, oracle: { providerId: "codex", model: " ", reasoningLevel: "high" } } }, expectedRevision: current.revision })).rejects.toThrow();
    await writeFile(target, "broken json");
    await expect(s.get()).rejects.toThrow(/Invalid agent models/);
    await expect(s.save({ models: current.models, expectedRevision: current.revision })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("broken json");
  });
});

describe("subagent instructions", () => {
  it("follow the file at each thread start and say so plainly when it breaks", async () => {
    const s = await setup();
    expect(s.instructions()).toContain("| Workhorse | pi | zai/glm-5.3-flash | high |");
    const current = readAgentModels();
    // A file sync changes the config behind Pipeline's back; the next thread must see it without a reload.
    await writeAgentModels({ ...current.models, subagents: { ...current.models.subagents,
      workhorse: { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high", serviceTier: "fast" } } }, current.revision);
    expect(s.instructions()).toContain("| Workhorse | codex | gpt-6-sol | high, fast tier |");
    await writeFile(s.path, "{broken");
    const broken = s.instructions();
    expect(broken).toContain("could not be read");
    expect(broken).toContain("Ask the user before spawning subagents");
    expect(broken).not.toContain("| Workhorse |");
  });
});
