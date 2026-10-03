import { expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

it.each(["environment lookup", "project lookup", "missing source"])(
  "rejects unresolved mutations during %s, then persists retries under the stable key",
  async (failure) => {
    let unresolved = true;
    const threadsGet = async () => makeThreadResponse({
      id: "thread-sam", projectId: "project-assistants", environmentId: "env-sam",
    });
    const environmentsGet = async ({ environmentId }: { environmentId: string }) => {
      if (unresolved && failure === "environment lookup") throw new Error("host offline");
      return { id: environmentId, projectId: "project-assistants", hostId: "host-new", path: "/test/assistants/sam" };
    };
    const projectsGet = async () => {
      if (unresolved && failure === "project lookup") throw new Error("project not found during reconnect");
      return { sources: unresolved && failure === "missing source"
        ? [] : [{ hostId: "host-new", path: "/test/assistants" }] };
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "inbox-sidebar",
      sdk: {
        threads: { get: threadsGet },
        environments: { get: environmentsGet },
        projects: { get: projectsGet },
      },
    });
    plugin(bb);
    const db = bb.storage.database();
    try {
      await vi.waitFor(() => expect(db.prepare("SELECT done FROM assistant_key_migration").get()).toEqual({ done: 1 }));
      db.exec(`
        INSERT INTO assistant_subtitles VALUES
          ('project-assistants:sam', 'Saved stable subtitle', 100),
          ('env-sam', 'Saved fallback subtitle', 50);
        INSERT INTO assistant_order VALUES ('project-assistants:forge', 0), ('project-assistants:sam', 1);
      `);
      const snapshot = () => ({
        subtitles: db.prepare("SELECT * FROM assistant_subtitles ORDER BY identity").all(),
        order: db.prepare("SELECT * FROM assistant_order ORDER BY rank").all(),
        migrations: db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all(),
      });
      const before = snapshot();
      for (const subtitle of ["Stranded edit", ""]) {
        await expect(harness.behavior.callRpc("setAssistantSubtitle", { threadId: "thread-sam", subtitle })).rejects.toThrow(/unresolved/i);
        const cli = await harness.behavior.runCli(["subtitle", "thread-sam", subtitle || "--clear"]);
        expect(cli.exitCode).toBe(1);
        expect(cli.stderr).toMatch(/unresolved/i);
        expect(snapshot()).toEqual(before);
      }
      await expect(harness.behavior.callRpc("setAssistantOrder", {
        identities: ["project-assistants:sam", "env-sam"],
      })).rejects.toThrow(/unresolved/i);
      await expect(harness.behavior.callRpc("assistantIdentities", {
        environmentIds: ["env-sam"],
      })).rejects.toThrow(/unresolved/i);
      expect(snapshot()).toEqual(before);
      expect(await harness.behavior.runCli(["subtitle", "thread-sam"])).toMatchObject({
        exitCode: 0, stdout: "Saved fallback subtitle\n",
      });

      unresolved = false;
      expect(await harness.behavior.callRpc("assistantIdentities", { environmentIds: ["env-sam"] })).toEqual({
        rows: [{ environmentId: "env-sam", identity: "project-assistants:sam" }],
      });
      expect(await harness.behavior.callRpc("setAssistantSubtitle", { threadId: "thread-sam", subtitle: "Retried edit" })).toEqual({ ok: true });
      expect(await harness.behavior.callRpc("setAssistantOrder", {
        identities: ["env-sam", "project-assistants:forge", "project-assistants:sam"],
      })).toEqual({ ids: ["project-assistants:sam", "project-assistants:forge"] });
      expect(db.prepare("SELECT subtitle FROM assistant_subtitles WHERE identity = 'env-sam'").get()).toBeUndefined();

      const restarted = await harness.lifecycle.reload(plugin);
      try {
        expect(await restarted.harness.behavior.runCli(["subtitle", "thread-sam"])).toMatchObject({
          exitCode: 0, stdout: "Retried edit\n",
        });
        expect(await restarted.harness.behavior.callRpc("assistantOrder", {})).toEqual({
          ids: ["project-assistants:sam", "project-assistants:forge"],
        });
        expect(restarted.bb.storage.database().prepare("SELECT done FROM assistant_key_migration").get()).toEqual({ done: 1 });
        expect(await restarted.harness.behavior.runCli(["subtitle", "thread-sam", "--clear"])).toMatchObject({ exitCode: 0 });
        expect(await restarted.harness.behavior.callRpc("listAssistantSubtitles", {})).toEqual({
          rows: [],
        });
        expect(restarted.bb.storage.database().prepare("SELECT * FROM _bb_migrations ORDER BY id").all()).toEqual(before.migrations);
      } finally {
        await restarted.harness.lifecycle.dispose();
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  },
);

it.each([null, "/test/assistants", "/test/assistants/sam/nested", "/test/other/sam", "gone"])(
  "keeps final non-home fallback mutations working for %s",
  async (path) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "inbox-sidebar" });
    harness.sdk.stub("threads.get", async () => makeThreadResponse({
      id: "thread-other", projectId: "project-assistants", environmentId: "env-other",
    }));
    harness.sdk.stub("environments.get", async () => {
      if (path === "gone") throw new Error("environment not found");
      return { id: "env-other", projectId: "project-assistants", hostId: "host-a", path };
    });
    harness.sdk.stub("projects.get", async () => ({
      sources: [{ hostId: "host-a", path: "/test/assistants" }],
    }));
    plugin(bb);
    try {
      expect(await harness.behavior.callRpc("assistantIdentities", { environmentIds: ["env-other"] })).toEqual({
        rows: [{ environmentId: "env-other", identity: "env-other" }],
      });
      await harness.behavior.callRpc("setAssistantSubtitle", { threadId: "thread-other", subtitle: "Fallback" });
      expect(await harness.behavior.callRpc("listAssistantSubtitles", {})).toEqual({
        rows: [{ identity: "env-other", subtitle: "Fallback" }],
      });
      expect(await harness.behavior.callRpc("setAssistantOrder", { identities: ["env-other"] })).toEqual({ ids: ["env-other"] });
      await harness.behavior.callRpc("setAssistantSubtitle", { threadId: "thread-other", subtitle: "" });
      expect(await harness.behavior.callRpc("listAssistantSubtitles", {})).toEqual({ rows: [] });
    } finally {
      await harness.lifecycle.dispose();
    }
  },
);
