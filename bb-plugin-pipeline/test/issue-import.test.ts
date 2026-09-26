import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createIssueImporter } from "../lib/issue-import";
import { createCardStore, MIGRATIONS } from "../lib/store";
import { makeImportedIssue } from "./sdk-fake";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => { while (hosts.length) await hosts.pop()!.harness.lifecycle.dispose(); });

function setup() {
  const host = createFakePluginHost({ pluginId: "pipeline", sdk: { projects: {
    get: async ({ projectId }) => ({
      id: projectId, kind: "standard", name: "Example", gitRemoteUrl: "git@github.com:example/repo.git",
      createdAt: 1, updatedAt: 1, sources: [],
    }),
  } } });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db);
  const readIssue = vi.fn(async (url: string) => makeImportedIssue({ url, number: Number(url.split("/").at(-1)) }));
  const readViewer = vi.fn(async () => "ratul");
  const listIssues = vi.fn(async () => ({ issues: [makeImportedIssue()], hasMore: true }));
  const publish = vi.fn();
  const importer = createIssueImporter({ sdk: host.bb.sdk, store, publish, readIssue, readViewer, listIssues });
  return { host, db, store, readIssue, readViewer, listIssues, publish, importer };
}

describe("GitHub issue intake", () => {
  it("deduplicates concurrent imports across reloads without starting work or choosing execution", async () => {
    const s = setup();
    const [first, second] = await Promise.all([
      s.importer.import("proj_1", [12, 12]), s.importer.import("proj_1", [12]),
    ]);
    expect(first.errors).toEqual([]);
    expect(second.cards[0]?.id).toBe(first.cards[0]?.id);
    const cards = createCardStore(s.db).list("proj_1", true);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      column: "backlog", startRequested: false, hostId: null, intake: null, lead: null,
      intakeThreadId: null, leadThreadId: null, issueUrl: makeImportedIssue().url,
      importedIssue: { importedBy: "ratul", body: "Original description" },
    });
    expect(s.store.history(cards[0]!.id).map((entry) => entry.kind)).toEqual(["created"]);
    expect(s.host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    await s.importer.import("proj_2", [12]);
    expect(s.store.list("proj_2")).toHaveLength(1);
  });

  it("recognizes an issue already linked to a regular or done task", async () => {
    const s = setup();
    const card = s.store.create({ id: "existing", projectId: "proj_1", hostId: "host", title: "Regular", body: "notes", attachments: [], source: "ui" });
    s.store.update(card.id, { issueUrl: "https://github.com/EXAMPLE/REPO/issues/12#issuecomment-1", column: "done" });
    const listed = await s.importer.list("proj_1", 2);
    expect(listed.issues[0]?.cardId).toBe(card.id);
    expect(s.listIssues).toHaveBeenCalledWith("example/repo", "ratul", 2);
    const result = await s.importer.import("proj_1", [12]);
    expect(result.cards[0]).toMatchObject({ id: card.id, body: "notes", column: "done" });
    expect(s.readIssue).not.toHaveBeenCalled();
  });

  it("reports partial import failures and revalidates open state and assignment", async () => {
    const s = setup();
    s.readIssue.mockImplementation(async (url) => {
      const number = Number(url.split("/").at(-1));
      if (number === 13) throw new Error("GitHub is unavailable");
      return makeImportedIssue({ url, number, state: number === 14 ? "closed" : "open", assignees: number === 15 ? [] : ["RaTuL"] });
    });
    const result = await s.importer.import("proj_1", [12, 13, 14, 15]);
    expect(result.cards).toHaveLength(1);
    expect(result.errors.map((error) => error.number).sort()).toEqual([13, 14, 15]);
    expect(s.store.list("proj_1")).toHaveLength(1);
    await expect(s.importer.import("proj_1", [1.5])).rejects.toThrow("issue numbers");
    await expect(s.importer.list("proj_1", 0)).rejects.toThrow("page");
  });

  it("preserves notes and workflow through failed refreshes and closed or reassigned issues", async () => {
    const s = setup();
    const card = (await s.importer.import("proj_1", [12])).cards[0]!;
    s.store.update(card.id, { body: "Approved local scope", column: "planning" });
    const revision = s.store.get(card.id)!.revision;
    s.readIssue.mockRejectedValueOnce(new Error("rate limited"));
    await expect(s.importer.refresh(card.id)).rejects.toThrow("rate limited");
    expect(s.store.get(card.id)).toMatchObject({
      body: "Approved local scope", column: "planning", revision,
      importedIssue: { body: "Original description", error: "rate limited" },
    });
    s.readIssue.mockResolvedValueOnce(makeImportedIssue({ body: "Edited on GitHub", state: "closed", assignees: ["someone-else"] }));
    const refreshed = await s.importer.refresh(card.id);
    expect(refreshed).toMatchObject({
      body: "Approved local scope", column: "planning", revision,
      importedIssue: { body: "Edited on GitHub", state: "closed", assignees: ["someone-else"], importedBy: "ratul", error: null },
    });
  });
});
