import { expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { boardRpcContract } from "../server";

it.each(["", "Edited subtitle"])("persists a subtitle mutation (%j) across deferred migration and source registration", async (subtitle) => {
  let sourceRegistered = false;
  const { bb, harness } = createFakePluginHost({
    pluginId: "inbox-sidebar",
    sdk: {
      threads: { get: async () => makeThreadResponse({ id: "thread-sam", projectId: "fleet", environmentId: "env-local" }) },
      environments: { get: async ({ environmentId }) => ({
        id: environmentId, projectId: "fleet", hostId: environmentId === "env-remote" ? "host-new" : "host-a",
        path: environmentId === "env-remote" ? "/new/assistants/sam" : "/test/assistants/sam",
      }) },
      projects: { get: async () => ({ sources: [
        { hostId: "host-a", path: "/test/assistants" },
        ...(sourceRegistered ? [{ hostId: "host-new", path: "/new/assistants" }] : []),
      ] }) },
    },
  });
  plugin(bb);
  const db = bb.storage.database();
  db.exec(`INSERT INTO assistant_subtitles VALUES
    ('env-local', 'Local legacy subtitle', 100),
    ('env-remote', 'Remote legacy subtitle', 200),
    ('fleet:forge', 'Unrelated subtitle', 300)`);
  const migrations = db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
  try {
    await vi.waitFor(() => expect(db.prepare("SELECT * FROM assistant_subtitles WHERE identity = 'env-local'").all()).toEqual([]));
    expect(db.prepare("SELECT done FROM assistant_key_migration").get()).toBeUndefined();
    expect(db.prepare("SELECT subtitle FROM assistant_subtitles WHERE identity = 'env-remote'").get()).toEqual({ subtitle: "Remote legacy subtitle" });
    expect(await harness.behavior.callRpc("setAssistantSubtitle", { threadId: "thread-sam", subtitle })).toEqual({ ok: true });
    expect(await harness.behavior.runCli(["subtitle", "thread-sam"])).toMatchObject({ exitCode: 0, stdout: `${subtitle || "(none)"}\n` });
    const displayed = boardRpcContract.listAssistantSubtitles.output.parse(await harness.behavior.callRpc("listAssistantSubtitles", {}));
    expect(displayed.rows.filter((row) => row.identity === "fleet:sam")).toEqual(subtitle ? [{ identity: "fleet:sam", subtitle }] : []);

    const deferred = await harness.lifecycle.reload(plugin);
    try {
      await vi.waitFor(() => expect(deferred.harness.inspection.logEntries.some((entry) => entry.message.includes("assistant key migration deferred: 1 keys"))).toBe(true));
      expect(deferred.bb.storage.database().prepare("SELECT done FROM assistant_key_migration").get()).toBeUndefined();
      expect(await deferred.harness.behavior.runCli(["subtitle", "thread-sam"])).toMatchObject({ exitCode: 0, stdout: `${subtitle || "(none)"}\n` });
      sourceRegistered = true;
      const completed = await deferred.harness.lifecycle.reload(plugin);
      try {
        const db = completed.bb.storage.database();
        await vi.waitFor(() => expect(db.prepare("SELECT done FROM assistant_key_migration").get()).toEqual({ done: 1 }));
        const expected = [
          { identity: "fleet:forge", subtitle: "Unrelated subtitle" },
          ...(subtitle ? [{ identity: "fleet:sam", subtitle }] : []),
        ];
        expect(db.prepare("SELECT identity, subtitle FROM assistant_subtitles ORDER BY identity").all()).toEqual(expected);
        const displayed = boardRpcContract.listAssistantSubtitles.output.parse(await completed.harness.behavior.callRpc("listAssistantSubtitles", {}));
        expect(displayed.rows.sort((a, b) => a.identity.localeCompare(b.identity))).toEqual(expected);
        expect(await completed.harness.behavior.runCli(["subtitle", "thread-sam"])).toMatchObject({ exitCode: 0, stdout: `${subtitle || "(none)"}\n` });
        expect(db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all()).toEqual(migrations);
      } finally {
        await completed.harness.lifecycle.dispose();
      }
    } finally {
      await deferred.harness.lifecycle.dispose();
    }
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each(["", "New subtitle"])("preserves a subtitle mutation (%j) while migration awaits another environment", async (subtitle) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const { bb, harness } = createFakePluginHost({
    pluginId: "inbox-sidebar",
    sdk: {
      threads: { get: async ({ threadId }) => makeThreadResponse({
        id: threadId, projectId: "fleet", environmentId: threadId === "thread-sam" ? "env-sam" : "env-forge",
      }) },
      environments: { get: async ({ environmentId }) => {
        if (environmentId === "env-blocked") await blocked;
        const home = environmentId === "env-forge" ? "forge" : environmentId === "env-untouched" ? "hands" : "sam";
        return { id: environmentId, projectId: "fleet", hostId: "host-a", path: `/test/assistants/${home}` };
      } },
      projects: { get: async () => ({ sources: [{ hostId: "host-a", path: "/test/assistants" }] }) },
    },
  });
  plugin(bb);
  const db = bb.storage.database();
  const future = Date.now() + 60_000;
  db.prepare("INSERT INTO assistant_subtitles VALUES (?, ?, ?)").run("env-sam", "Legacy current environment", future);
  db.prepare("INSERT INTO assistant_subtitles VALUES (?, ?, ?)").run("env-blocked", "Legacy other environment", future + 1);
  db.exec(`INSERT INTO assistant_subtitles VALUES ('fleet:sam', 'Stable old subtitle', 100), ('fleet:forge', 'Unrelated subtitle', 200), ('env-untouched', 'Untouched legacy subtitle', 300)`);
  const migrations = db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
  try {
    await vi.waitFor(() => expect(harness.sdk.callsTo("environments.get").flat()).toContainEqual({ environmentId: "env-blocked" }));
    await harness.behavior.callRpc("setAssistantSubtitle", { threadId: "thread-sam", subtitle });
    await harness.behavior.callRpc("setAssistantSubtitle", { threadId: "thread-forge", subtitle: "Concurrent unrelated edit" });
    expect(db.prepare("SELECT * FROM assistant_subtitles WHERE identity = 'env-sam'").all()).toEqual([]);
    release();
    await vi.waitFor(() => expect(db.prepare("SELECT done FROM assistant_key_migration").get()).toEqual({ done: 1 }));
    const expected = [
      { identity: "fleet:forge", subtitle: "Concurrent unrelated edit" },
      { identity: "fleet:hands", subtitle: "Untouched legacy subtitle" },
      ...(subtitle ? [{ identity: "fleet:sam", subtitle }] : []),
    ];
    expect(db.prepare("SELECT identity, subtitle FROM assistant_subtitles ORDER BY identity").all()).toEqual(expected);
    const displayed = boardRpcContract.listAssistantSubtitles.output.parse(await harness.behavior.callRpc("listAssistantSubtitles", {}));
    expect(displayed.rows.sort((a, b) => a.identity.localeCompare(b.identity))).toEqual(expected);
    expect(await harness.behavior.runCli(["subtitle", "thread-sam"])).toMatchObject({ exitCode: 0, stdout: `${subtitle || "(none)"}\n` });
    const restarted = await harness.lifecycle.reload(plugin);
    try {
      expect(restarted.bb.storage.database().prepare("SELECT identity, subtitle FROM assistant_subtitles ORDER BY identity").all()).toEqual(expected);
      const displayed = boardRpcContract.listAssistantSubtitles.output.parse(await restarted.harness.behavior.callRpc("listAssistantSubtitles", {}));
      expect(displayed.rows.sort((a, b) => a.identity.localeCompare(b.identity))).toEqual(expected);
      expect(await restarted.harness.behavior.runCli(["subtitle", "thread-sam"])).toMatchObject({ exitCode: 0, stdout: `${subtitle || "(none)"}\n` });
      expect(restarted.bb.storage.database().prepare("SELECT * FROM _bb_migrations ORDER BY id").all()).toEqual(migrations);
    } finally {
      await restarted.harness.lifecycle.dispose();
    }
  } finally {
    release();
    await harness.lifecycle.dispose();
  }
});
