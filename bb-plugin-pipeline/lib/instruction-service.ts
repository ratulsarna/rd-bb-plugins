import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { readGuidelines as readExternalGuidelines, type GuidelinesSettings } from "./guidelines";
import { readWorkflow } from "./workflow";
import { readPackagedInstruction } from "./instruction-default";
import { validateInstructionFields } from "./prompt-template";
import { createInstructionStore, InstructionConflictError, type InstructionOverride } from "./instruction-store";
import {
  INSTRUCTION_DOCUMENTS, instructionReadInputSchema, instructionSaveInputSchema, instructionResetInputSchema, instructionSnapshotSchema,
  type InstructionId, type InstructionDocument, type InstructionReader, type InstructionSnapshot,
  type InstructionSaveInput, type InstructionResetInput,
} from "./instruction-types";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export { readPackagedInstruction } from "./instruction-default";

export function snapshotInstructionReader(snapshot: InstructionSnapshot): InstructionReader {
  return {
    async readContent(id) {
      instructionReadInputSchema.parse({ id });
      const content = snapshot.documents[id];
      if (typeof content !== "string") throw new Error(`Pipeline instruction snapshot is missing ${id}`);
      return content;
    },
  };
}

export function createInstructionService(options: {
  db: Database;
  getSettings?: () => Promise<GuidelinesSettings>;
  publish?: () => void;
  readDefault?: (id: InstructionId) => Promise<string>;
}) {
  const store = createInstructionStore(options.db);
  const readDefault = options.readDefault ?? readPackagedInstruction;
  const pinned = (cardId: string): InstructionSnapshot | null => {
    const saved = store.pinned(cardId);
    return saved === null ? null : instructionSnapshotSchema.parse(JSON.parse(saved));
  };
  function document(id: InstructionId, defaultContent: string, override?: InstructionOverride): InstructionDocument {
    const entry = INSTRUCTION_DOCUMENTS.find((entry) => entry.id === id)!;
    return {
      ...entry,
      source: override?.content == null ? "default" : "custom",
      revision: hash([id, defaultContent, override?.version ?? 0]),
      updatedAt: override?.updatedAt ?? null,
      content: override?.content ?? defaultContent,
      defaultContent,
    };
  }
  async function read(input: { id: InstructionId }) {
    const { id } = instructionReadInputSchema.parse(input);
    const defaultContent = await readDefault(id);
    return document(id, defaultContent, store.get(id));
  }
  async function all() {
    const defaults = await Promise.all(INSTRUCTION_DOCUMENTS.map(({ id }) => readDefault(id)));
    const overrides = new Map(store.all().map((entry) => [entry.id, entry]));
    return INSTRUCTION_DOCUMENTS.map(({ id }, index) => document(id, defaults[index]!, overrides.get(id)));
  }
  async function write(input: InstructionResetInput, content: string | null) {
    await service.pinStarted();
    const defaultContent = await readDefault(input.id);
    const current = store.get(input.id);
    if (document(input.id, defaultContent, current).revision !== input.expectedRevision) throw new InstructionConflictError();
    const saved = document(input.id, defaultContent, store.write(input.id, content, current?.version ?? 0));
    options.publish?.();
    return saved;
  }
  async function guidelines(settings?: GuidelinesSettings, snapshot?: InstructionSnapshot) {
    if (snapshot) return { source: "Pipeline task guidelines", content: await snapshotInstructionReader(snapshot).readContent("guidelines/README.md") };
    const configured = settings ?? await options.getSettings?.() ?? {};
    if (configured.guidelinesFile?.trim()) return readExternalGuidelines(configured);
    return { source: "Pipeline's guidelines", content: (await read({ id: "guidelines/README.md" })).content };
  }
  const service = {
    async list() {
      return { documents: (await all()).map(({ content, defaultContent, ...summary }) => summary) };
    },
    read,
    save(input: InstructionSaveInput) {
      const parsed = instructionSaveInputSchema.parse(input);
      validateInstructionFields(parsed.id, parsed.content);
      return write(parsed, parsed.content);
    },
    reset(input: InstructionResetInput) {
      return write(instructionResetInputSchema.parse(input), null);
    },
    async readContent(id: InstructionId) {
      return (await read({ id })).content;
    },
    readWorkflow(phase = "overview", file?: string, snapshot?: InstructionSnapshot) {
      return readWorkflow(phase, file, snapshot ? snapshotInstructionReader(snapshot) : service);
    },
    readGuidelines: guidelines,
    pinned,
    async pinStarted(settings?: GuidelinesSettings): Promise<void> {
      const ids = store.unpinnedCardIds();
      if (ids.length === 0) return;
      const snapshot = JSON.stringify(await service.snapshot(settings));
      for (const id of ids) store.pin(id, snapshot);
    },
    async pin(cardId: string, settings?: GuidelinesSettings): Promise<InstructionSnapshot> {
      const existing = pinned(cardId);
      if (existing) return existing;
      const snapshot = await service.snapshot(settings);
      return instructionSnapshotSchema.parse(JSON.parse(store.pin(cardId, JSON.stringify(snapshot))));
    },
    async snapshot(settings?: GuidelinesSettings): Promise<InstructionSnapshot> {
      const configured = settings ?? await options.getSettings?.() ?? {};
      const external = configured.guidelinesFile?.trim() ? await readExternalGuidelines(configured) : null;
      const documents = Object.fromEntries((await all()).map(({ id, content }) => [id, content])) as InstructionSnapshot["documents"];
      if (external) documents["guidelines/README.md"] = external.content;
      return { revision: hash(documents), documents };
    },
  };
  return service;
}

export type InstructionService = ReturnType<typeof createInstructionService>;
