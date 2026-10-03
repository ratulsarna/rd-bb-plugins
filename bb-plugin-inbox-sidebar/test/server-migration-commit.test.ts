import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { ASSISTANT_ORDER_CHANNEL, SUBTITLE_CHANNEL } from "../server";

async function fixture(pendingSource = false) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { bb, harness } = createFakePluginHost({
    pluginId: "inbox-sidebar",
    sdk: {
      environments: { get: async ({ environmentId }) => {
        await gate;
        const remote = environmentId === "env-remote";
        return { id: environmentId, projectId: "fleet", hostId: remote ? "remote" : "local", path: `/synthetic/assistants/${remote ? "forge" : "sam"}` };
      } },
      projects: { get: async () => ({ sources: [
        { hostId: "local", path: "/synthetic/assistants" },
        ...(!pendingSource ? [{ hostId: "remote", path: "/synthetic/assistants" }] : []),
      ] }) },
    },
  });
  plugin(bb);
  const db = bb.storage.database();
  db.exec(`INSERT INTO assistant_subtitles VALUES ('env-local', 'Sam subtitle', 100), ('env-remote', 'Forge subtitle', 200);
    INSERT INTO assistant_order VALUES ('env-local', 0), ('env-remote', 1);`);
  const snapshot = () => ({
    subtitles: db.prepare("SELECT * FROM assistant_subtitles ORDER BY identity").all(),
    order: db.prepare("SELECT * FROM assistant_order ORDER BY rank").all(),
    flag: db.prepare("SELECT * FROM assistant_key_migration").all(),
    migrations: db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all(),
  });
  await vi.waitFor(() => expect(harness.sdk.callsTo("environments.get")).toHaveLength(2));
  return { bb, harness, db, release, snapshot };
}

it.each(["assistant_order", "assistant_key_migration"])("rolls back both metadata tables on a real %s insertion failure and retries on restart", async (table) => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    f.db.exec(`CREATE TRIGGER reject_migration BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic insertion failure'); END;`);
    f.release();
    await vi.waitFor(() => expect(f.harness.inspection.logEntries.some((entry) => entry.message.includes("synthetic insertion failure"))).toBe(true));
    expect(f.snapshot()).toEqual(before);
    expect(f.harness.inspection.realtimeSignals).toEqual([]);
    f.db.exec("DROP TRIGGER reject_migration");
    const restarted = await f.harness.lifecycle.reload(plugin);
    try {
      const db = restarted.bb.storage.database();
      await vi.waitFor(() => expect(db.prepare("SELECT done FROM assistant_key_migration").get()).toEqual({ done: 1 }));
      expect(await restarted.harness.behavior.callRpc("listAssistantSubtitles", {})).toEqual({ rows: [
        { identity: "fleet:sam", subtitle: "Sam subtitle" }, { identity: "fleet:forge", subtitle: "Forge subtitle" },
      ] });
      expect(await restarted.harness.behavior.callRpc("assistantOrder", {})).toEqual({ ids: ["fleet:sam", "fleet:forge"] });
      expect(db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all()).toEqual(before.migrations);
      expect(restarted.harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual([SUBTITLE_CHANNEL, ASSISTANT_ORDER_CHANNEL]);
    } finally {
      await restarted.harness.lifecycle.dispose();
    }
  } finally {
    f.release();
    await f.harness.lifecycle.dispose();
  }
});

it("notifies open observers of committed partial key changes while another source remains missing", async () => {
  const f = await fixture(true);
  const reads: Array<Promise<unknown>> = [];
  const committed: ReturnType<typeof f.snapshot>[] = [];
  const publish = f.bb.realtime.publish.bind(f.bb.realtime);
  vi.spyOn(f.bb.realtime, "publish").mockImplementation((channel, payload) => {
    committed.push(f.snapshot());
    reads.push(f.harness.behavior.callRpc(channel === SUBTITLE_CHANNEL ? "listAssistantSubtitles" : "assistantOrder", {}));
    publish(channel, payload);
  });
  try {
    f.release();
    await vi.waitFor(() => expect(f.harness.inspection.logEntries.some((entry) => entry.message.includes("deferred: 1 keys"))).toBe(true));
    expect(f.harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual([SUBTITLE_CHANNEL, ASSISTANT_ORDER_CHANNEL]);
    expect(await Promise.all(reads)).toEqual([
      { rows: [{ identity: "fleet:sam", subtitle: "Sam subtitle" }, { identity: "env-remote", subtitle: "Forge subtitle" }] },
      { ids: ["fleet:sam", "env-remote"] },
    ]);
    expect(committed).toHaveLength(2);
    for (const snapshot of committed) {
      expect(snapshot.flag).toEqual([]);
      expect(snapshot.order).toEqual([{ identity: "fleet:sam", rank: 0 }, { identity: "env-remote", rank: 1 }]);
      expect(snapshot.subtitles.map((row) => (row as { identity: string }).identity)).toEqual(["env-remote", "fleet:sam"]);
    }
  } finally {
    f.release();
    await f.harness.lifecycle.dispose();
  }
});
