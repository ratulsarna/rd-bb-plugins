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
      for (const migration of MIGRATIONS.slice(4)) db.exec(migration);
      const store = createCardStore(db);
      expect(store.get("card_1")).toEqual({ ...before, startRequested: true, runState: "running", pauseRequestId: null, controlError: null });
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

  it("adds run-next storage without changing existing cards", () => {
    const db = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.slice(0, 5)) db.exec(migration);
      db.prepare(
        `INSERT INTO cards
          (id, project_id, host_id, title, body, attachments, "column", run_state, created_at, updated_at)
         VALUES ('card_1', 'proj_1', 'host_mac', 'Existing card', 'Keep me', '[]', 'todo', 'running', 1, 2)`,
      ).run();

      db.exec(MIGRATIONS[5]);

      expect(createCardStore(db).get("card_1")).toMatchObject({
        id: "card_1",
        projectId: "proj_1",
        hostId: "host_mac",
        title: "Existing card",
        body: "Keep me",
        column: "todo",
        updatedAt: 2,
      });
    } finally {
      db.close();
    }
  });

  it("keeps existing cards started when adding durable start intent", () => {
    const db = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.slice(0, -1)) db.exec(migration);
      db.prepare(
        `INSERT INTO cards
          (id, project_id, host_id, title, body, attachments, "column", created_at, updated_at)
         VALUES ('card_1', 'proj_1', 'host_mac', 'Existing card', 'Keep me', '[]', 'todo', 1, 2)`,
      ).run();

      db.exec(MIGRATIONS.at(-1)!);

      expect(createCardStore(db).get("card_1")?.startRequested).toBe(true);
      expect(() => db.prepare("UPDATE cards SET start_requested = 2 WHERE id = 'card_1'").run()).toThrow();
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
      expect(card.startRequested).toBe(true);
      expect(createCardStore(db).get(card.id)).toMatchObject({ intake, lead });
    } finally {
      db.close();
    }
  });

  it("round-trips an explicitly saved card and later start request", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) db.exec(migration);
    try {
      const store = createCardStore(db);
      const saved = store.create({
        id: "card_saved",
        projectId: "proj_1",
        hostId: "host_mac",
        startRequested: false,
        title: "Ship later",
        body: "",
        attachments: [],
        source: "ui",
      });

      expect(saved.startRequested).toBe(false);
      expect(createCardStore(db).get(saved.id)?.startRequested).toBe(false);
      store.update(saved.id, { startRequested: true });
      expect(createCardStore(db).get(saved.id)?.startRequested).toBe(true);
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

describe("run next", () => {
  function addCard(
    store: ReturnType<typeof createCardStore>,
    id: string,
    projectId: string,
    hostId: string,
  ) {
    return store.create({
      id,
      projectId,
      hostId,
      title: id,
      body: "",
      attachments: [],
      source: "test",
    });
  }

  it("persists one nominee per project and machine without touching card timestamps", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) db.exec(migration);
    try {
      let time = 100;
      const store = createCardStore(db, () => time++);
      const first = addCard(store, "first", "project_a", "host_a");
      addCard(store, "replacement", "project_a", "host_a");
      addCard(store, "other_host", "project_a", "host_b");
      addCard(store, "other_project", "project_b", "host_a");

      store.setRunNext(first.id);
      expect(store.get(first.id)?.updatedAt).toBe(first.updatedAt);
      expect(createCardStore(db).getRunNext("project_a", "host_a")).toBe(first.id);

      store.setRunNext("replacement");
      store.setRunNext("other_host");
      store.setRunNext("other_project");
      expect(store.getRunNext("project_a", "host_a")).toBe("replacement");
      expect(store.getRunNext("project_a", "host_b")).toBe("other_host");
      expect(store.getRunNext("project_b", "host_a")).toBe("other_project");
      const persisted = createCardStore(db).listRunNext();
      expect(persisted).toHaveLength(3);
      expect(persisted).toEqual(expect.arrayContaining([
        { projectId: "project_a", hostId: "host_a", cardId: "replacement" },
        { projectId: "project_a", hostId: "host_b", cardId: "other_host" },
        { projectId: "project_b", hostId: "host_a", cardId: "other_project" },
      ]));

      store.update(first.id, { runState: "pause_requested" });
      expect(store.clearRunNext(first.id)).toBe(false);
      expect(store.getRunNext("project_a", "host_a")).toBe("replacement");
      expect(store.clearRunNext("replacement")).toBe(true);
      expect(store.getRunNext("project_a", "host_a")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("requires a known card with a machine", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) db.exec(migration);
    try {
      const store = createCardStore(db);
      db.prepare(
        `INSERT INTO cards (id, project_id, title, "column", created_at, updated_at)
         VALUES ('legacy', 'project_a', 'Legacy', 'backlog', 1, 1)`,
      ).run();

      expect(() => store.setRunNext("missing")).toThrow("unknown card missing");
      expect(() => store.setRunNext("legacy")).toThrow("card legacy has no machine");
    } finally {
      db.close();
    }
  });

  it("clears nominees when they are held, completed, or removed", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) db.exec(migration);
    try {
      const store = createCardStore(db);
      addCard(store, "held", "project_a", "host_a");
      addCard(store, "done", "project_a", "host_b");
      addCard(store, "removed", "project_b", "host_a");

      store.setRunNext("held");
      store.setRunNext("done");
      store.setRunNext("removed");
      store.update("held", { runState: "pause_requested" });
      store.update("done", { column: "done" });
      store.remove("removed");

      expect(store.getRunNext("project_a", "host_a")).toBeNull();
      expect(store.getRunNext("project_a", "host_b")).toBeNull();
      expect(store.getRunNext("project_b", "host_a")).toBeNull();
    } finally {
      db.close();
    }
  });
});
