import { z } from "zod";

export const INSTRUCTION_DOCUMENTS = [
  { id: "README.md", title: "Overview", group: "phases", phase: "overview", file: "README.md" },
  { id: "intake/README.md", title: "Intake", group: "phases", phase: "intake", file: "README.md" },
  { id: "plan/README.md", title: "Planning", group: "phases", phase: "plan", file: "README.md" },
  { id: "implement/README.md", title: "Implementation", group: "phases", phase: "implement", file: "README.md" },
  { id: "debug/README.md", title: "Debugging", group: "phases", phase: "debug", file: "README.md" },
  { id: "close-out/README.md", title: "Close-out", group: "phases", phase: "close-out", file: "README.md" },
  { id: "plan/templates/oracle.md", title: "Planning · Oracle", group: "templates", phase: "plan", file: "templates/oracle.md" },
  { id: "implement/templates/developer.md", title: "Implementation · Developer", group: "templates", phase: "implement", file: "templates/developer.md" },
  { id: "implement/templates/oracle.md", title: "Implementation · Oracle", group: "templates", phase: "implement", file: "templates/oracle.md" },
  { id: "implement/templates/qa.md", title: "Implementation · QA", group: "templates", phase: "implement", file: "templates/qa.md" },
  { id: "debug/templates/debugger.md", title: "Debugging · Debugger", group: "templates", phase: "debug", file: "templates/debugger.md" },
  { id: "kickoff/intake.md", title: "Intake kickoff", group: "kickoff", phase: "kickoff", file: "intake.md" },
  { id: "kickoff/intake-imported.md", title: "Imported issue intake kickoff", group: "kickoff", phase: "kickoff", file: "intake-imported.md" },
  { id: "kickoff/lead.md", title: "Lead kickoff", group: "kickoff", phase: "kickoff", file: "lead.md" },
  { id: "kickoff/lead-imported.md", title: "Imported issue lead kickoff", group: "kickoff", phase: "kickoff", file: "lead-imported.md" },
  { id: "kickoff/workflow.md", title: "Workflow access", group: "kickoff", phase: "kickoff", file: "workflow.md" },
  { id: "kickoff/user-handoff.md", title: "User handoff", group: "kickoff", phase: "kickoff", file: "user-handoff.md" },
  { id: "kickoff/imported-issue.md", title: "Imported issue rules", group: "kickoff", phase: "kickoff", file: "imported-issue.md" },
  { id: "kickoff/review-feedback.md", title: "External review follow-up", group: "kickoff", phase: "kickoff", file: "review-feedback.md" },
  { id: "guidelines/README.md", title: "Guidelines", group: "guidelines", phase: "guidelines", file: "README.md" },
] as const;

export type InstructionId = typeof INSTRUCTION_DOCUMENTS[number]["id"];
export const MAX_INSTRUCTION_BYTES = 256 * 1024;
export const INSTRUCTIONS_CHANGED = "instructions:changed";

export const instructionIdSchema = z.enum(INSTRUCTION_DOCUMENTS.map(({ id }) => id));
export const instructionContentSchema = z.string()
  .refine((value) => value.trim() !== "", "Instructions cannot be blank")
  .refine((value) => new TextEncoder().encode(value).length <= MAX_INSTRUCTION_BYTES, "Instructions must be 256 KB or smaller");
const revisionSchema = z.string().min(1).max(128);
export const instructionReadInputSchema = z.object({ id: instructionIdSchema }).strict();
export const instructionSaveInputSchema = instructionReadInputSchema.extend({
  content: instructionContentSchema,
  expectedRevision: revisionSchema,
}).strict();
export const instructionResetInputSchema = instructionReadInputSchema.extend({ expectedRevision: revisionSchema }).strict();
export const instructionSummarySchema = z.object({
  id: instructionIdSchema,
  title: z.string(),
  group: z.enum(["phases", "templates", "kickoff", "guidelines"]),
  phase: z.string(),
  file: z.string(),
  source: z.enum(["default", "custom"]),
  revision: revisionSchema,
  updatedAt: z.number().int().nonnegative().nullable(),
}).strict();
export const instructionDocumentSchema = instructionSummarySchema.extend({
  content: instructionContentSchema,
  defaultContent: instructionContentSchema,
}).strict();
export const instructionListSchema = z.object({ documents: z.array(instructionSummarySchema) }).strict();
export const instructionSnapshotSchema = z.object({
  revision: revisionSchema,
  documents: z.record(z.string(), instructionContentSchema),
}).strict();
export type InstructionSummary = z.infer<typeof instructionSummarySchema>;
export type InstructionDocument = z.infer<typeof instructionDocumentSchema>;
export type InstructionSnapshot = z.infer<typeof instructionSnapshotSchema>;
export type InstructionSaveInput = z.infer<typeof instructionSaveInputSchema>;
export type InstructionResetInput = z.infer<typeof instructionResetInputSchema>;

export interface InstructionReader {
  readContent(id: InstructionId): Promise<string>;
}
