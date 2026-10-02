import { readFile } from "node:fs/promises";
import { instructionReadInputSchema, type InstructionId } from "./instruction-types";

export async function readPackagedInstruction(id: InstructionId): Promise<string> {
  instructionReadInputSchema.parse({ id });
  try {
    // Source modules and the bundled server both sit one level below the plugin root.
    return await readFile(new URL(`../workflows/${id}`, import.meta.url), "utf8");
  } catch {
    throw new Error(`Pipeline workflow document ${id} is unavailable; check the plugin installation`);
  }
}
