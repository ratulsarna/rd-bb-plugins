// @vitest-environment jsdom
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstructionService } from "../lib/instruction-service";
import { MIGRATIONS } from "../lib/store";
import { INSTRUCTIONS_CHANGED, INSTRUCTION_DOCUMENTS, type InstructionDocument, type InstructionId, type InstructionSaveInput, type InstructionResetInput } from "../lib/instruction-types";
import { chooseSelectOption } from "./select";

await loadPluginApp(() => import("../app"));
const { InstructionSettings } = await import("../components/instruction-settings");

const mounted: Array<{ slot: ReturnType<typeof renderSlot>; db: Database.Database }> = [];
afterEach(() => {
  for (const { slot, db } of mounted.splice(0)) { slot.lifecycle.unmount(); db.close(); }
  cleanup(); vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(guidelinesFile = "") {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const service = createInstructionService({ db, readDefault: (id) => readFile(join(process.cwd(), "workflows", id), "utf8") });
  const read = vi.fn((input: { id: InstructionId }) => service.read(input));
  const save = vi.fn((input: InstructionSaveInput) => service.save(input));
  const reset = vi.fn((input: InstructionResetInput) => service.reset(input));
  const slot = renderSlot({ component: InstructionSettings }, { guidelinesFile }, { rpc: {
    listInstructions: () => service.list(),
    readInstruction: (input) => read(input as { id: InstructionId }),
    saveInstruction: (input) => save(input as InstructionSaveInput),
    resetInstruction: (input) => reset(input as InstructionResetInput),
  } });
  mounted.push({ slot, db });
  await screen.findByRole("textbox", { name: "Instruction text" });
  return { slot, service, read, save, reset };
}
const editor = () => screen.getByRole("textbox", { name: "Instruction text" }) as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: "Save instructions" }) as HTMLButtonElement;
function edit(content: string) { fireEvent.change(editor(), { target: { value: content } }); }
async function select(id: InstructionId, expected: string) {
  const title = INSTRUCTION_DOCUMENTS.find((entry) => entry.id === id)!.title;
  await chooseSelectOption(screen.getByRole("combobox", { name: "Document" }), new RegExp(`^${title}(?: · (?:Unsaved|Custom))?$`));
  await waitFor(() => expect(editor().value).toBe(expected));
}

describe("instruction Settings editor", () => {
  it("retains independent drafts across picker changes and realtime updates, then requires an explicit conflict choice", async () => {
    const s = await setup();
    const original = await s.service.read({ id: "README.md" });
    const plan = await s.service.read({ id: "plan/README.md" });
    const firstDraft = "  Team overview\n\nKeep this wording.  \n";
    edit(firstDraft);
    await select(plan.id, plan.content);
    edit("Planning draft\n");
    await s.service.save({ id: original.id, content: "Other teammate’s overview\n", expectedRevision: original.revision });
    await s.slot.behavior.emitRealtime(INSTRUCTIONS_CHANGED, {});
    expect(editor().value).toBe("Planning draft\n");
    await select(original.id, firstDraft);
    await screen.findByText("The saved instructions changed while you were editing. Your draft is preserved. Compare with the saved version before saving.");
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Other teammate’s overview", { selector: "pre" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    fireEvent.click(saveButton());
    await screen.findByText("Instructions saved");
    expect((await s.service.read({ id: original.id })).content).toBe(firstDraft);
    await select(plan.id, "Planning draft\n");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(editor().value).toBe(plan.content);
    expect(s.save).toHaveBeenCalledTimes(1);
  });

  it("locks in-flight writes and retains the draft and error after a failed save so retry uses the exact text", async () => {
    const s = await setup();
    const original = await s.service.read({ id: "README.md" });
    const content = "\n  # Team instructions\n\tKeep trailing spaces.  \n\n";
    edit(content);
    const pending = deferred<InstructionDocument>();
    s.save.mockImplementationOnce(() => pending.promise);
    fireEvent.click(saveButton());
    expect(editor().disabled).toBe(true);
    expect(screen.getByRole("combobox", { name: "Document" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(s.save).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error("Write failed")));
    await waitFor(() => expect(editor().disabled).toBe(false));
    await screen.findByText("Write failed");
    await s.slot.behavior.emitRealtime(INSTRUCTIONS_CHANGED, {});
    await waitFor(() => expect(s.read.mock.calls.length).toBeGreaterThan(2));
    expect(screen.getByText("Write failed")).toBeTruthy();
    expect(editor().value).toBe(content);
    fireEvent.click(saveButton());
    await screen.findByText("Instructions saved");
    expect(s.save).toHaveBeenLastCalledWith({ id: original.id, content, expectedRevision: original.revision });
    expect((await s.service.read({ id: original.id })).content).toBe(content);
  });

  it("ignores an older refresh finishing after a successful save", async () => {
    const s = await setup();
    const original = await s.service.read({ id: "README.md" });
    const stale = deferred<InstructionDocument>();
    s.read.mockImplementationOnce(() => stale.promise);
    await s.slot.behavior.emitRealtime(INSTRUCTIONS_CHANGED, {});
    edit("Newest saved instructions\n");
    fireEvent.click(saveButton());
    await screen.findByText("Instructions saved");
    await act(async () => stale.resolve(original));
    expect(editor().value).toBe("Newest saved instructions\n");
    expect(saveButton().disabled).toBe(true);
  });

  it("preserves saved line endings and untouched whitespace when the textarea normalizes its displayed value", async () => {
    const s = await setup();
    const original = await s.service.read({ id: "README.md" });
    const content = "\uFEFF  First line\r\nSecond line  \n\tThird line\r\n\r\n";
    await s.service.save({ id: original.id, content, expectedRevision: original.revision });
    await s.slot.behavior.emitRealtime(INSTRUCTIONS_CHANGED, {});
    await waitFor(() => expect(editor().value).toBe(content.replace(/\r\n/g, "\n")));
    edit(editor().value.replace("Second line", "Edited second line"));
    fireEvent.click(saveButton());
    await screen.findByText("Instructions saved");
    expect((await s.service.read({ id: original.id })).content).toBe(content.replace("Second line", "Edited second line"));
    const saved = await s.service.read({ id: original.id });
    await s.service.save({ id: original.id, content: "First\r\n\nLast\n", expectedRevision: saved.revision });
    await s.slot.behavior.emitRealtime(INSTRUCTIONS_CHANGED, {});
    await waitFor(() => expect(editor().value).toBe("First\n\nLast\n"));
    fireEvent.change(editor(), { target: { value: "First\nLast\n", selectionStart: 5 } });
    fireEvent.click(saveButton());
    await waitFor(async () => expect((await s.service.read({ id: original.id })).content).toBe("First\nLast\n"));
  });

  it("previews and stages the shipped default, supports discarding it, and resets only on Save", async () => {
    const s = await setup();
    const original = await s.service.read({ id: "README.md" });
    edit("Custom policy\n"); fireEvent.click(saveButton());
    await screen.findByText("Instructions saved");
    await screen.findByText("Saved custom instructions");
    fireEvent.click(screen.getByText("Shipped default", { selector: "summary" }));
    expect(document.querySelector(".pipeline-instruction-default pre")?.textContent).toBe(original.defaultContent);
    fireEvent.click(screen.getByRole("button", { name: "Restore default" }));
    expect(editor().value).toBe(original.defaultContent);
    expect((await s.service.read({ id: original.id })).content).toBe("Custom policy\n");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(editor().value).toBe("Custom policy\n");
    fireEvent.click(screen.getByRole("button", { name: "Restore default" }));
    fireEvent.click(saveButton());
    await screen.findByText("Shipped default restored");
    expect(s.reset).toHaveBeenCalledTimes(1);
    expect(s.save).toHaveBeenCalledTimes(1);
    expect((await s.service.read({ id: original.id })).source).toBe("default");
  });

  it("retains a failed read’s drafts and validates blank text and unknown kickoff fields without sending them", async () => {
    const s = await setup("/team/guidelines.md");
    edit("Keep my draft\n");
    s.read.mockRejectedValueOnce(new Error("Instructions unavailable on server"));
    await s.slot.behavior.emitRealtime(INSTRUCTIONS_CHANGED, {});
    await screen.findByText("Instructions unavailable on server");
    expect(editor().value).toBe("Keep my draft\n");
    edit(" \n\t");
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Instructions cannot be blank")).toBeTruthy();
    const kickoff = await s.service.read({ id: "kickoff/intake.md" });
    await select(kickoff.id, kickoff.content);
    edit("Hello {{unrecognised_field}}\n");
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/Unknown instruction field/)).toBeTruthy();
    const guidelines = await s.service.read({ id: "guidelines/README.md" });
    await select(guidelines.id, guidelines.content);
    expect(screen.getByText(/New tasks use the external guidelines file configured above/)).toBeTruthy();
    expect(s.save).not.toHaveBeenCalled();
  });
});
