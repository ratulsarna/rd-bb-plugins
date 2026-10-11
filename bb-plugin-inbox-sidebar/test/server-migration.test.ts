import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { assistantRpcContract } from "../server";

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

// The 8 statements the plugin ships, copied verbatim from server.ts on main.
// bb hashes each statement by index and refuses a changed list, so these are
// frozen here on purpose: the upgrade tests below fail if the plugin's list
// drifts from what today's databases were built with.
const TODAY_MIGRATIONS = [
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
  `CREATE TABLE IF NOT EXISTS assistant_key_migration (
       done INTEGER NOT NULL
     )`,
  `CREATE TABLE thread_overrides_next (
       thread_id TEXT PRIMARY KEY,
       override  TEXT NOT NULL CHECK (override IN ('settled', 'active', 'snoozed')),
       at        INTEGER NOT NULL,
       until     INTEGER,
       CHECK ((override = 'snoozed') = (until IS NOT NULL))
     )`,
  `INSERT INTO thread_overrides_next (thread_id, override, at)
       SELECT thread_id, override, at FROM thread_overrides`,
  `DROP TABLE thread_overrides`,
  `ALTER TABLE thread_overrides_next RENAME TO thread_overrides`,
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
    const records = old.prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id").all();
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

    expect(reopened.prepare("SELECT id, statement_hash FROM _bb_migrations WHERE id < 3 ORDER BY id").all()).toEqual(records);
    expect(reopened.prepare("SELECT id FROM _bb_migrations ORDER BY id").all()).toEqual([
      { id: 0 }, { id: 1 }, { id: 2 }, { id: 3 },
      { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 },
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

    const migrated = reopened.prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id").all();
    const replacement = await harness.lifecycle.reload(plugin);
    try {
      expect(replacement.bb.storage.database().prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id").all()).toEqual(migrated);
      expect(assistantRpcContract.listAssistantSubtitles.output.parse(
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

it("rebuilds a historical database to today's ledger and serves the inbox and the assistant side together", async () => {
  // The ledger the frozen statements write on a fresh database.
  const reference = createFakePluginHost({ pluginId: "inbox-sidebar" });
  let referenceLedger: unknown[];
  try {
    reference.bb.storage.migrate(reference.bb.storage.database(), TODAY_MIGRATIONS);
    referenceLedger = reference.bb.storage
      .database()
      .prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id")
      .all() as unknown[];
  } finally {
    await reference.harness.lifecycle.dispose();
  }
  expect(referenceLedger).toHaveLength(8);

  const { bb, harness } = createFakePluginHost({ pluginId: "inbox-sidebar" });
  try {
    // The historical database: the three oldest statements first, as the
    // plugin always applied them, with live data already in the tables.
    const old = bb.storage.database();
    bb.storage.migrate(old, TODAY_MIGRATIONS.slice(0, 3));
    old.exec(`
      INSERT INTO thread_overrides VALUES ('thr-settled', 'settled', 100);
      INSERT INTO thread_overrides VALUES ('thr-active', 'active', 200);
      INSERT INTO assistant_subtitles VALUES ('env-sam', 'Chief of staff', 10);
      INSERT INTO assistant_order VALUES ('env-sam', 0);
    `);
    // The plugin's full list over it: 1-3 are no-ops, 4-8 run. A drifted
    // statement anywhere would make bb refuse the list right here.
    bb.storage.migrate(old, TODAY_MIGRATIONS);
    // Snoozes only became storable once the rebuilt table existed.
    const until = Date.now() + 86_400_000;
    old.prepare(`INSERT INTO thread_overrides VALUES ('thr-later', 'snoozed', 300, ?)`).run(until);
    expect(old.prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id").all()).toEqual(referenceLedger);

    plugin(bb);
    expect(await harness.behavior.callRpc("listOverrides", {})).toEqual({
      rows: [
        { threadId: "thr-settled", override: "settled", at: 100 },
        { threadId: "thr-active", override: "active", at: 200 },
        { threadId: "thr-later", override: "snoozed", at: 300, until },
      ],
    });
    const snoozeUntil = Date.now() + 3_600_000;
    expect(await harness.behavior.callRpc("snooze", { threadId: "thr-active", until: snoozeUntil })).toEqual({ ok: true });
    expect(await harness.behavior.callRpc("wake", { threadId: "thr-active" })).toEqual({ ok: true });
    // Wake ends the snooze now: `until` is stamped with the wake, while
    // thr-later keeps sleeping until tomorrow.
    const afterWake = (await harness.behavior.callRpc("listOverrides", {})) as {
      rows: Array<{ threadId: string; override: string; until?: number }>;
    };
    expect(afterWake.rows.find((row) => row.threadId === "thr-active")).toMatchObject({
      override: "snoozed",
    });
    expect(afterWake.rows.find((row) => row.threadId === "thr-active")!.until!).toBeLessThanOrEqual(Date.now());
    expect(await harness.behavior.callRpc("assistantOrder", {})).toEqual({ ids: ["env-sam"] });
    expect(assistantRpcContract.listAssistantSubtitles.output.parse(
      await harness.behavior.callRpc("listAssistantSubtitles", {}),
    ).rows).toEqual([{ identity: "env-sam", subtitle: "Chief of staff" }]);

    const replacement = await harness.lifecycle.reload(plugin);
    try {
      const reloaded = (await replacement.harness.behavior.callRpc("listOverrides", {})) as {
        rows: Array<{ threadId: string; override: string }>;
      };
      expect(reloaded.rows.map((row) => [row.threadId, row.override])).toEqual([
        ["thr-settled", "settled"],
        ["thr-active", "snoozed"],
        ["thr-later", "snoozed"],
      ]);
      expect(await replacement.harness.behavior.callRpc("assistantOrder", {})).toEqual({ ids: ["env-sam"] });
      expect(await replacement.harness.behavior.callRpc("wake", { threadId: "thr-later" })).toEqual({ ok: true });
      expect(
        replacement.bb.storage.database().prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id").all(),
      ).toEqual(referenceLedger);
    } finally {
      await replacement.harness.lifecycle.dispose();
    }
  } finally {
    await harness.lifecycle.dispose();
  }
});
