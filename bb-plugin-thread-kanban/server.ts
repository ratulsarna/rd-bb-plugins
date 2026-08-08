// The settled-thread store. This state lives in the plugin's own database,
// never on bb's thread — uninstalling the plugin takes it with it.
//
// Two override kinds, because auto-settle needs both directions: "settled"
// parks a thread the timer would have kept, and "active" un-parks one the
// timer (or a finished PR) would otherwise re-settle on the next render.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
// Relative on purpose: a path install loads server.ts directly, where the
// bundler's "@/" alias does not exist.
import { pinnedRootIds } from "./lib/pinned-order";

const threadIdInput = z.object({ threadId: z.string().trim().min(1) });
const pinnedOrderOutput = z.object({ ids: z.array(z.string()) });

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
  pinnedOrder: { input: z.object({}), output: pinnedOrderOutput },
  movePinned: {
    input: z.object({
      threadId: z.string().trim().min(1),
      previousThreadId: z.string().trim().min(1).nullable(),
      nextThreadId: z.string().trim().min(1).nullable(),
    }),
    output: pinnedOrderOutput,
  },
});

/** Realtime channel the board re-reads overrides on. */
export const SETTLED_CHANNEL = "settled";

/** Realtime channel the board re-reads the pinned order on. */
export const PINNED_CHANNEL = "pinned-order";

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
    // Pin order is bb's, not ours: we read its list and write through its
    // reorder call. Nothing about it is stored in this plugin's database.
    async pinnedOrder() {
      return {
        ids: pinnedRootIds(await bb.sdk.threads.list({ archived: false })),
      };
    },
    async movePinned({ threadId, previousThreadId, nextThreadId }) {
      // Same derivation as the read. The app itself never trusts the response
      // array's order — it merges the returned sort keys and re-sorts — so
      // neither do we.
      const threads = await bb.sdk.threads.reorderPinned({
        threadId,
        previousThreadId,
        nextThreadId,
      });
      bb.realtime.publish(PINNED_CHANNEL, { threadId });
      return { ids: pinnedRootIds(threads) };
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
