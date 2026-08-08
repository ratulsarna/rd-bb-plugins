// The settled-thread store. This state lives in the plugin's own database,
// never on bb's thread — uninstalling the plugin takes it with it.
//
// Two override kinds, because auto-settle needs both directions: "settled"
// parks a thread the timer would have kept, and "active" un-parks one the
// timer (or a finished PR) would otherwise re-settle on the next render.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const threadIdInput = z.object({ threadId: z.string().trim().min(1) });

export const boardRpcContract = defineRpcContract({
  listOverrides: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          override: z.enum(["settled", "active"]),
          at: z.number(),
        }),
      ),
    }),
  },
  settle: { input: threadIdInput, output: z.object({ ok: z.boolean() }) },
  unsettle: { input: threadIdInput, output: z.object({ ok: z.boolean() }) },
});

/** Realtime channel the board re-reads overrides on. */
export const SETTLED_CHANNEL = "settled";

interface OverrideDbRow {
  thread_id: string;
  override: "settled" | "active";
  at: number;
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS thread_overrides (
       thread_id TEXT PRIMARY KEY,
       override  TEXT NOT NULL CHECK (override IN ('settled', 'active')),
       at        INTEGER NOT NULL
     )`,
  ]);

  const write = (threadId: string, override: "settled" | "active"): void => {
    db.prepare(
      `INSERT INTO thread_overrides (thread_id, override, at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         override = excluded.override,
         at = excluded.at`,
    ).run(threadId, override, Date.now());
    bb.realtime.publish(SETTLED_CHANNEL, { threadId });
  };

  bb.rpc.register(boardRpcContract, {
    async listOverrides() {
      const rows = (
        db
          .prepare(`SELECT thread_id, override, at FROM thread_overrides`)
          .all() as OverrideDbRow[]
      ).map((row) => ({
        threadId: row.thread_id,
        override: row.override,
        at: row.at,
      }));
      return { rows };
    },
    async settle({ threadId }) {
      write(threadId, "settled");
      return { ok: true };
    },
    async unsettle({ threadId }) {
      write(threadId, "active");
      return { ok: true };
    },
  });

  // A deleted thread must not leave an override behind that would park a
  // future thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    db.prepare(`DELETE FROM thread_overrides WHERE thread_id = ?`).run(
      thread.id,
    );
    bb.realtime.publish(SETTLED_CHANNEL, { threadId: thread.id });
  });
}
