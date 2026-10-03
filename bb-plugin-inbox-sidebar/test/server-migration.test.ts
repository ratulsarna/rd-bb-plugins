import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { boardRpcContract } from "../server";

// Historical SQL is a fixture independent of the plugin's current migrations.
const HISTORICAL_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS thread_overrides (
       thread_id TEXT PRIMARY KEY,
       override  TEXT NOT NULL CHECK (override IN ('settled', 'active')),
       at        INTEGER NOT NULL
     )`,
  `CREATE TABLE IF NOT EXISTS assistant_subtitles (
       environment_id TEXT PRIMARY KEY,
       subtitle       TEXT NOT NULL,
       at             INTEGER NOT NULL
     )`,
  `CREATE TABLE IF NOT EXISTS assistant_order (
       environment_id TEXT PRIMARY KEY,
       rank           INTEGER NOT NULL
     )`,
];

it("opens a historical database without changing migration records or losing sidebar data", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "inbox-sidebar" });
  try {
    const old = bb.storage.database();
    bb.storage.migrate(old, HISTORICAL_MIGRATIONS);
    old.exec(`
      INSERT INTO thread_overrides VALUES ('thread-work', 'settled', 42);
      INSERT INTO assistant_subtitles VALUES
        ('env-sam', 'Chief of staff', 100),
        ('env-gone', 'Keep my subtitle', 200);
      INSERT INTO assistant_order VALUES ('env-gone', 0), ('env-sam', 1);
    `);
    const records = old.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
    expect(records).toMatchObject([
      { id: 0, statement_hash: "78a14661ff3f73a06f0d302d1d4262ea9bd87667e98e13c06e210a169771cbef" },
      { id: 1, statement_hash: "442911c755a90cb41f98738232a589629b5a4f35ccd19306c68e33dc3b2361cd" },
      { id: 2, statement_hash: "16fb30e7455a69ae5355fe571ea4a2bf121d6fc73a49535777174b3b9041d3e2" },
    ]);
    old.close();
    const reopened = bb.storage.database();
    expect(reopened).not.toBe(old);
    harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => {
      if (environmentId === "env-gone") throw new Error("environment not found");
      return { id: environmentId, projectId: "project-assistants", hostId: "host-a", path: "/test/assistants/sam" };
    });
    harness.sdk.stub("projects.get", async () => ({
      sources: [{ hostId: "host-a", path: "/test/assistants" }],
    }));

    plugin(bb);
    await vi.waitFor(() => expect(
      reopened.prepare("SELECT done FROM assistant_key_migration").get(),
    ).toEqual({ done: 1 }));

    expect(reopened.prepare("SELECT * FROM _bb_migrations WHERE id < 3 ORDER BY id").all()).toEqual(records);
    expect(reopened.prepare("SELECT id FROM _bb_migrations ORDER BY id").all()).toEqual([
      { id: 0 }, { id: 1 }, { id: 2 }, { id: 3 },
    ]);
    expect(reopened.prepare("SELECT * FROM assistant_subtitles ORDER BY at").all()).toEqual([
      { identity: "project-assistants:sam", subtitle: "Chief of staff", at: 100 },
      { identity: "env-gone", subtitle: "Keep my subtitle", at: 200 },
    ]);
    expect(await harness.behavior.callRpc("assistantOrder", {})).toEqual({
      ids: ["env-gone", "project-assistants:sam"],
    });
    expect(await harness.behavior.callRpc("listOverrides", {})).toEqual({
      rows: [{ threadId: "thread-work", override: "settled", at: 42 }],
    });

    const migrated = reopened.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
    const replacement = await harness.lifecycle.reload(plugin);
    try {
      expect(replacement.bb.storage.database().prepare("SELECT * FROM _bb_migrations ORDER BY id").all()).toEqual(migrated);
      expect(boardRpcContract.listAssistantSubtitles.output.parse(
        await replacement.harness.behavior.callRpc("listAssistantSubtitles", {}),
      ).rows).toHaveLength(2);
      expect(await replacement.harness.behavior.callRpc("assistantOrder", {})).toEqual({
        ids: ["env-gone", "project-assistants:sam"],
      });
    } finally {
      await replacement.harness.lifecycle.dispose();
    }
  } finally {
    await harness.lifecycle.dispose();
  }
});
