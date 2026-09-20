import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createCardStore, MIGRATIONS } from "../lib/store";

const intake = {
  providerId: "codex",
  model: "gpt-6-astra",
  reasoningLevel: "xhigh" as const,
  serviceTier: "fast" as const,
};

const lead = {
  providerId: "pi",
  model: "zai/glm-5.3-flash",
  reasoningLevel: "high" as const,
};

describe("card migrations", () => {
  it("migrates running cards and persists an acknowledged pause without losing task data", () => {
    const db = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.slice(0, 4)) db.exec(migration);
      db.prepare(`INSERT INTO cards (id, project_id, title, "column", lead_thread_id, owner_role, created_at, updated_at)
        VALUES ('card_1', 'proj_1', 'Existing work', 'implementing', 'lead', 'lead', 1, 2)`).run();
      const before = createCardStore(db).get("card_1")!;
      db.exec(MIGRATIONS[4]);
      const store = createCardStore(db);
      expect(store.get("card_1")).toEqual({ ...before, runState: "running", pauseRequestId: null, controlError: null });
      store.update("card_1", { runState: "pausing", pauseRequestId: "request", controlError: "machine offline" });
      const reloaded = createCardStore(db);
      expect(reloaded.listControlled()).toEqual([expect.objectContaining({
        id: "card_1", column: "implementing", leadThreadId: "lead", runState: "pausing",
        pauseRequestId: "request", controlError: "machine offline",
      })]);
      reloaded.update("card_1", { runState: "running", pauseRequestId: null, controlError: null });
      expect(reloaded.listControlled()).toEqual([]);
    } finally {
      db.close();
    }
  });

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

  it("preserves legacy rows with null execution snapshots", () => {
    const db = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.slice(0, 3)) db.exec(migration);
      db.prepare(
        `INSERT INTO cards
          (id, project_id, host_id, title, body, attachments, "column", created_at, updated_at)
         VALUES ('card_1', 'proj_1', 'host_mac', 'Existing card', 'Keep me', '[]', 'todo', 1, 2)`,
      ).run();

      db.exec(MIGRATIONS[3]);

      expect(createCardStore(db).get("card_1")).toMatchObject({
        id: "card_1",
        hostId: "host_mac",
        title: "Existing card",
        body: "Keep me",
        column: "todo",
        intake: null,
        lead: null,
      });
    } finally {
      db.close();
    }
  });
});

describe("card execution", () => {
  it("round-trips distinct intake and lead snapshots", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) db.exec(migration);
    try {
      const store = createCardStore(db);
      const card = store.create({
        id: "card_1",
        projectId: "proj_1",
        hostId: "host_mac",
        intake,
        lead,
        title: "Ship it",
        body: "",
        attachments: [],
        source: "cli",
      });

      expect(card.intake).toEqual(intake);
      expect(card.lead).toEqual(lead);
      expect(createCardStore(db).get(card.id)).toMatchObject({ intake, lead });
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
