import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createPipelineCli } from "../lib/cli";
import type { MachineQueue } from "../lib/contract";
import { createCardStore, MIGRATIONS } from "../lib/store";

function setup() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  const store = createCardStore(db);
  const card = store.create({
    id: "waiting",
    projectId: "project_a",
    hostId: "host_a",
    title: "Urgent fix",
    body: "",
    attachments: [],
    source: "test",
  });
  const queue: MachineQueue[] = [{
    hostId: "host_a",
    hostName: "Work laptop",
    limit: 2,
    occupied: [{ cardId: "running", title: "Existing work", threadId: "thread_running" }],
    waiting: [{
      cardId: card.id,
      title: card.title,
      threadId: null,
      reasons: ["Pipeline: 2 tasks running", "Waiting for approval"],
      canRunNext: true,
    }],
    nextCardId: card.id,
  }];
  const setRunNext = vi.fn(async () => undefined);
  const cli = createPipelineCli({
    service: {} as never,
    store,
    sdk: {} as never,
    controls: {} as never,
    capacity: {
      snapshot: vi.fn(async () => queue),
      setRunNext,
    } as never,
  });
  return { db, card, cli, setRunNext };
}

describe("pipeline queue CLI", () => {
  it("derives list and show queue details from every waiting reason", async () => {
    const { db, card, cli } = setup();
    try {
      const context = { projectId: "project_a" } as never;
      const listed = await cli.run(["list", "--json"], context);
      expect(JSON.parse(listed.stdout!)).toMatchObject([{
        id: card.id,
        queued: true,
        waitingReasons: ["Pipeline: 2 tasks running", "Waiting for approval"],
        runNext: true,
      }]);

      const shown = await cli.run(["show", card.id, "--json"], context);
      expect(JSON.parse(shown.stdout!)).toMatchObject({
        card: { id: card.id },
        queued: true,
        waitingReasons: ["Pipeline: 2 tasks running", "Waiting for approval"],
        runNext: true,
      });
    } finally {
      db.close();
    }
  });

  it("prints machine occupancy and delegates choosing and clearing run next", async () => {
    const { db, card, cli, setRunNext } = setup();
    try {
      const context = { projectId: "project_a" } as never;
      const result = await cli.run(["queue"], context);
      expect(result.stdout).toContain("Work laptop (host_a) — 1/2 slots occupied");
      expect(result.stdout).toContain("running  Existing work");
      expect(result.stdout).toContain(`${card.id}  ${card.title}  [NEXT; Pipeline: 2 tasks running; Waiting for approval]`);

      await cli.run(["run-next", card.id], context);
      await cli.run(["run-next", card.id, "--clear", "--json"], context);
      expect(setRunNext).toHaveBeenNthCalledWith(1, card.id, true);
      expect(setRunNext).toHaveBeenNthCalledWith(2, card.id, false);
    } finally {
      db.close();
    }
  });
});
