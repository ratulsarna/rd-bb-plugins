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
});
