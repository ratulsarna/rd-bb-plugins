import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReviewModels, writeReviewModels } from "@ratulsarna/agent-models";
import plugin from "../server";
import { reviewModelSettingsSchema } from "../lib/review-models";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.unstubAllEnvs();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pipeline-review-models-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  vi.stubEnv("AGENT_MODELS_CONFIG", path);
  const host = createFakePluginHost({ pluginId: "pipeline", agentSkillIds: ["pipeline"] });
  cleanup.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  const get = async () => reviewModelSettingsSchema.parse(await host.harness.behavior.callRpc("getReviewModels", null));
  const save = (input: unknown) => host.harness.behavior.callRpc("updateReviewModels", input);
  return { root, path, host, get, save };
}

describe("shared review model RPC", () => {
  it("serves defaults without a file, saves the same pair the standalone reader sees, and rejects stale saves", async () => {
    const s = await setup();
    const initial = await s.get();
    expect(initial.source).toBe("defaults");
    await expect(lstat(s.path)).rejects.toMatchObject({ code: "ENOENT" });
    const models = { ...initial.models, second: { providerId: "pi", model: "zai/custom-reviewer", reasoningLevel: "medium" } };
    await s.save({ models, expectedRevision: initial.revision });
    expect((await readReviewModels()).models).toEqual(models);
    await expect(s.save({ models: initial.models, expectedRevision: initial.revision })).rejects.toThrow(/changed/);
    expect((await s.get()).models).toEqual(models);
    const stored = s.host.harness.inspection.sdk.calls;
    expect(stored).toEqual([]);
  });

  it("preserves a synced symlink and refuses corrupt data or invalid requests", async () => {
    const s = await setup();
    const target = join(s.root, "synced.json");
    const initial = await readReviewModels(target);
    await writeReviewModels(initial.models, initial.revision, target);
    await symlink(target, s.path);
    const before = await s.get();
    await s.save({ models: { ...before.models, first: { providerId: "codex", model: "custom", reasoningLevel: "high" } }, expectedRevision: before.revision });
    expect((await lstat(s.path)).isSymbolicLink()).toBe(true);
    expect((await readReviewModels(target)).models.first.model).toBe("custom");
    const current = await s.get();
    await expect(s.save({ models: { ...current.models, first: { providerId: "codex", model: " ", reasoningLevel: "high" } }, expectedRevision: current.revision })).rejects.toThrow();
    await writeFile(target, "broken json");
    await expect(s.get()).rejects.toThrow(/Invalid review models/);
    await expect(s.save({ models: current.models, expectedRevision: current.revision })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("broken json");
  });
});
