import { readPackagedInstruction } from "./instruction-default";
import { INSTRUCTION_DOCUMENTS, type InstructionReader } from "./instruction-types";

const DOCUMENTS = INSTRUCTION_DOCUMENTS.filter(({ group }) => group !== "guidelines");
const PHASES = [...new Set(DOCUMENTS.map(({ phase }) => phase))];

export async function readWorkflow(phase = "overview", requestedFile?: string, instructions?: InstructionReader) {
  const available = DOCUMENTS.filter((entry) => entry.phase === phase);
  if (available.length === 0) {
    throw new Error(`unknown workflow phase ${phase}; choose ${PHASES.join(", ")}, or guidelines`);
  }
  if (phase === "overview" && requestedFile !== undefined) {
    throw new Error("overview does not accept --file");
  }
  const file = requestedFile ?? "README.md";
  const entry = available.find((entry) => entry.file === file);
  if (!entry) {
    throw new Error(`unknown ${phase} document ${file}; choose ${available.map(({ file }) => file).join(", ")}`);
  }
  if (instructions) return { phase, file, content: await instructions.readContent(entry.id) };
  return { phase, file, content: await readPackagedInstruction(entry.id) };
}
