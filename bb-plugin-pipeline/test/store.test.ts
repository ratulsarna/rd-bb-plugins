import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createCardStore, MIGRATIONS } from "../lib/store";

describe("card migrations", () => {
  it("backfills lead ownership after an earlier planning move", () => {
    const db = new Database(":memory:");
    try {
      db.exec(MIGRATIONS[0]);
      db.prepare(
        `INSERT INTO cards (id, project_id, title, "column", created_at, updated_at)
         VALUES ('card_1', 'proj_1', 'Existing card', 'todo', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO card_history
          (card_id, at, kind, from_column, to_column, source)
         VALUES ('card_1', 1, 'moved', 'todo', 'planning', 'report')`,
      ).run();

      db.exec(MIGRATIONS[1]);

      expect(createCardStore(db).get("card_1")?.ownerRole).toBe("lead");
    } finally {
      db.close();
    }
  });

  it("reads preexisting rows as unassigned after the host_id migration", () => {
    const db = new Database(":memory:");
    try {
      db.exec(MIGRATIONS[0]);
      db.exec(MIGRATIONS[1]);
      db.prepare(
        `INSERT INTO cards (id, project_id, title, "column", created_at, updated_at)
         VALUES ('card_1', 'proj_1', 'Existing card', 'todo', 1, 1)`,
      ).run();

      db.exec(MIGRATIONS[2]);

      expect(createCardStore(db).get("card_1")?.hostId).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("card machines", () => {
  it("assigns a legacy card exactly once: history plus revision on first, no-op on same, refusal on change", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) db.exec(migration);
    try {
      const store = createCardStore(db, (() => {
        let now = 100;
        return () => now++;
      })());
      db.prepare(
        `INSERT INTO cards (id, project_id, title, "column", created_at, updated_at)
         VALUES ('card_1', 'proj_1', 'Legacy card', 'backlog', 1, 1)`,
      ).run();
      const unassigned = store.get("card_1")!;
      expect(unassigned.hostId).toBeNull();
      const historyLength = store.history("card_1").length;

      const assigned = store.setHost("card_1", "host_mac");
      expect(assigned).toMatchObject({
        hostId: "host_mac",
        revision: unassigned.revision + 1,
      });
      expect(store.history("card_1").at(-1)).toMatchObject({
        kind: "machine_assigned",
        note: "host_mac",
      });

      expect(store.setHost("card_1", "host_mac")).toEqual(assigned);
      expect(store.history("card_1")).toHaveLength(historyLength + 1);

      expect(() => store.setHost("card_1", "host_linux")).toThrow(
        "already assigned to machine host_mac",
      );
      expect(store.get("card_1")?.hostId).toBe("host_mac");
    } finally {
      db.close();
    }
  });
});
