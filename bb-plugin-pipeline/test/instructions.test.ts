import Database from "better-sqlite3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCardStore, MIGRATIONS } from "../lib/store";
import { createInstructionService, readPackagedInstruction } from "../lib/instruction-service";
import { INSTRUCTION_DOCUMENTS, MAX_INSTRUCTION_BYTES, type InstructionId } from "../lib/instruction-types";

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
function database(path = ":memory:") {
  const db = new Database(path); databases.push(db);
  db.pragma("foreign_keys = ON");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pipeline-instructions-")); directories.push(path); return path;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("saved Pipeline instructions", () => {
  it("serves every catalogue default exactly and resolves each phase/template/kickoff through the same catalogue", async () => {
    const service = createInstructionService({ db: database() });
    const list = await service.list();
    expect(list.documents.map(({ id }) => id)).toEqual(INSTRUCTION_DOCUMENTS.map(({ id }) => id));
    for (const entry of INSTRUCTION_DOCUMENTS) {
      const content = await readFile(new URL(`../workflows/${entry.id}`, import.meta.url), "utf8");
      const document = await service.read({ id: entry.id });
      expect(document).toMatchObject({ ...entry, source: "default", content, defaultContent: content, updatedAt: null });
      const delivered = entry.group === "guidelines" ? await service.readGuidelines()
        : await service.readWorkflow(entry.phase, entry.phase === "overview" ? undefined : entry.file);
      expect(delivered.content).toBe(content);
    }
  });

  it("retains exact text across save, database reopen and reset, and rejects a pre-reset tab", async () => {
    const path = join(await directory(), "instructions.db");
    const db = database(path);
    const service = createInstructionService({ db });
    const original = await service.read({ id: "plan/README.md" });
    const content = "\uFEFF  # Team planning\r\n\tUse π and 😀.  \r\n\r\n";
    const saved = await service.save({ id: original.id, content, expectedRevision: original.revision });
    expect(saved).toMatchObject({ content, defaultContent: original.content, source: "custom" });
    expect(saved.revision).not.toBe(original.revision);
    db.close();
    const reopened = new Database(path); databases.push(reopened);
    const reloaded = createInstructionService({ db: reopened });
    expect(await reloaded.read({ id: original.id })).toEqual(saved);
    expect((await reloaded.readWorkflow("plan")).content).toBe(content);
    expect((await reloaded.snapshot()).documents[original.id]).toBe(content);
    const reset = await reloaded.reset({ id: saved.id, expectedRevision: saved.revision });
    expect(reset).toMatchObject({ source: "default", content: original.content, defaultContent: original.content });
    expect(reset.revision).not.toBe(original.revision);
    await expect(reloaded.save({ id: original.id, content: "Stale edit", expectedRevision: original.revision })).rejects.toThrow("changed since");
    expect((await reloaded.read({ id: original.id })).content).toBe(original.content);
  });

  it("allows one concurrent writer per document while independent documents remain editable", async () => {
    const db = database();
    const publish = vi.fn();
    const first = createInstructionService({ db, publish });
    const second = createInstructionService({ db, publish });
    const original = await first.read({ id: "README.md" });
    const other = await second.read({ id: "debug/README.md" });
    const attempts = await Promise.allSettled([
      first.save({ id: original.id, content: "First tab", expectedRevision: original.revision }),
      second.save({ id: original.id, content: "Second tab", expectedRevision: original.revision }),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected") as PromiseRejectedResult;
    const winner = attempts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof first.save>>>;
    expect(rejected.reason.message).toContain("changed since");
    expect(publish).toHaveBeenCalledTimes(1);
    await second.save({ id: other.id, content: "Independent edit", expectedRevision: other.revision });
    await expect(second.reset({ id: original.id, expectedRevision: original.revision })).rejects.toThrow("changed since");
    expect((await first.read({ id: original.id })).content).toBe(winner.value.content);
  });

  it("rejects unknown paths, blank or oversized UTF-8 text and invalid template fields before writing", async () => {
    const db = database();
    const readDefault = vi.fn(readPackagedInstruction);
    const service = createInstructionService({ db, readDefault });
    for (const id of ["../package.json", "/etc/passwd", "__proto__", "plan/../README.md", "kickoff/missing.md"]) {
      await expect(service.read({ id: id as InstructionId })).rejects.toThrow();
      expect(() => service.save({ id: id as InstructionId, content: "Edit", expectedRevision: "stale" })).toThrow();
      expect(() => service.reset({ id: id as InstructionId, expectedRevision: "stale" })).toThrow();
    }
    expect(readDefault).not.toHaveBeenCalled();
    const original = await service.read({ id: "kickoff/intake.md" });
    for (const content of [" \r\n\t", "é".repeat(MAX_INSTRUCTION_BYTES / 2 + 1), "{{unknown_task_field}}"])
      expect(() => service.save({ id: original.id, content, expectedRevision: original.revision })).toThrow();
    expect(db.prepare("SELECT count(*) AS count FROM instruction_overrides").get()).toEqual({ count: 0 });
  });

  it("leaves the saved document intact when default loading or the database write fails", async () => {
    const db = database();
    let failRead = false;
    const service = createInstructionService({ db, readDefault: async (id) => {
      if (failRead) throw new Error("Package unavailable");
      return readPackagedInstruction(id);
    } });
    const original = await service.read({ id: "README.md" });
    const saved = await service.save({ id: original.id, content: "Saved text", expectedRevision: original.revision });
    failRead = true;
    await expect(service.reset({ id: saved.id, expectedRevision: saved.revision })).rejects.toThrow("Package unavailable");
    failRead = false;
    db.exec("CREATE TRIGGER fail_instruction_write BEFORE INSERT ON instruction_overrides BEGIN SELECT RAISE(FAIL, 'Disk write failed'); END");
    await expect(service.save({ id: saved.id, content: "Unsaved text", expectedRevision: saved.revision })).rejects.toThrow("Disk write failed");
    expect(await service.read({ id: saved.id })).toEqual(saved);
  });

  it("preserves overrides through shipped default upgrades and restores the upgraded default", async () => {
    const db = database();
    const before = createInstructionService({ db });
    const original = await before.read({ id: "plan/README.md" });
    const saved = await before.save({ id: original.id, content: "Our planning policy\n", expectedRevision: original.revision });
    const after = createInstructionService({ db, readDefault: async (id) => id === original.id ? "Upgraded planning\n" : readPackagedInstruction(id) });
    const upgraded = await after.read({ id: original.id });
    expect(upgraded).toMatchObject({ content: saved.content, defaultContent: "Upgraded planning\n", source: "custom" });
    await expect(after.reset({ id: saved.id, expectedRevision: saved.revision })).rejects.toThrow("changed since");
    expect((await after.reset({ id: upgraded.id, expectedRevision: upgraded.revision })).content).toBe("Upgraded planning\n");
  });

  it("pins one durable snapshot under concurrent kickoff and keeps it after edits, reopen and upgrades", async () => {
    const path = join(await directory(), "pins.db");
    const db = database(path);
    const cards = createCardStore(db);
    cards.create({ id: "card", projectId: "project", hostId: null, title: "Task", body: "", attachments: [], source: "test" });
    const started = deferred<void>(); const release = deferred<void>();
    const slow = createInstructionService({ db, readDefault: async (id) => {
      if (id === "README.md") { started.resolve(); await release.promise; return "Other kickoff candidate\n"; }
      return readPackagedInstruction(id);
    } });
    const fast = createInstructionService({ db });
    expect(fast.pinned("card")).toBeNull();
    const pending = slow.pin("card");
    await started.promise;
    const winner = await fast.pin("card");
    release.resolve();
    expect(await pending).toEqual(winner);
    const original = await fast.read({ id: "README.md" });
    await fast.save({ id: original.id, content: "New tasks only\n", expectedRevision: original.revision });
    expect((await fast.snapshot()).revision).not.toBe(winner.revision);
    expect((await fast.readWorkflow("overview", undefined, winner)).content).toBe(original.content);
    db.close();
    const reopened = new Database(path); databases.push(reopened); reopened.pragma("foreign_keys = ON");
    const after = createInstructionService({ db: reopened, readDefault: async () => { throw new Error("New package unavailable"); } });
    expect(after.pinned("card")).toEqual(winner);
    expect(await after.pin("card")).toEqual(winner);
    expect((await after.readWorkflow("overview", undefined, winner)).content).toBe(original.content);
    createCardStore(reopened).remove("card");
    expect(after.pinned("card")).toBeNull();
  });

  it("honours external guidelines ownership and pins the selected file contents for the task", async () => {
    const db = database();
    const file = join(await directory(), "team.md");
    await writeFile(file, "## Team\n\nExternal policy\n\n## Next\nOther text\n");
    const service = createInstructionService({ db, getSettings: async () => ({ guidelinesFile: file, guidelinesSection: "Team" }) });
    const original = await service.read({ id: "guidelines/README.md" });
    await service.save({ id: original.id, content: "Pipeline custom guidelines\r\n\r\n", expectedRevision: original.revision });
    const snapshot = await service.snapshot();
    expect((await service.readGuidelines()).content).toBe("## Team\n\nExternal policy\n");
    expect(snapshot.documents[original.id]).toBe("## Team\n\nExternal policy\n");
    expect((await service.readGuidelines({ guidelinesFile: "" })).content).toBe("Pipeline custom guidelines\r\n\r\n");
    await writeFile(file, "## Team\nChanged external policy\n");
    expect((await service.readGuidelines(undefined, snapshot)).content).toBe("## Team\n\nExternal policy\n");
    expect((await service.readGuidelines()).content).toContain("Changed external policy");
    expect(await readFile(file, "utf8")).toBe("## Team\nChanged external policy\n");
  });
});
