import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COLUMNS } from "./columns";

export const columnSchema = z.enum(COLUMNS);
export const tierSchema = z.enum(["trivial", "small", "standard"]);

export const attachmentSchema = z
  .object({
    path: z.string().min(1),
    filename: z.string().min(1),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    isImage: z.boolean(),
  })
  .strict();

export const cardSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    hostId: z.string().nullable(),
    title: z.string(),
    body: z.string(),
    attachments: z.array(attachmentSchema),
    column: columnSchema,
    needsUser: z.boolean(),
    attentionReason: z.string().nullable(),
    attentionSource: z.string().nullable(),
    attentionUnknown: z.boolean(),
    reportSignal: z.enum(["needs_you", "working"]).nullable(),
    tier: tierSchema.nullable(),
    issueUrl: z.string().nullable(),
    prUrl: z.string().nullable(),
    intakeThreadId: z.string().nullable(),
    leadThreadId: z.string().nullable(),
    ownerRole: z.enum(["intake", "lead"]),
    threadError: z.string().nullable(),
    launchError: z.string().nullable(),
    revision: z.number().int(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();

export const historySchema = z
  .object({
    id: z.number().int(),
    cardId: z.string(),
    at: z.number().int(),
    kind: z.string(),
    fromColumn: columnSchema.nullable(),
    toColumn: columnSchema.nullable(),
    source: z.string(),
    threadId: z.string().nullable(),
    note: z.string().nullable(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  listProjects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    }),
  },
  listCards: {
    input: z.object({ projectId: z.string(), includeDone: z.boolean() }).strict(),
    output: z.object({ cards: z.array(cardSchema), queuedCardIds: z.array(z.string()) }).strict(),
  },
  listMachines: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({
      machines: z.array(
        z.object({ id: z.string(), name: z.string(), status: z.string() }).strict(),
      ),
    }),
  },
  addCard: {
    input: z
      .object({
        projectId: z.string().min(1),
        hostId: z.string().trim().min(1),
        title: z.string().trim().min(1).max(500),
        body: z.string().max(20_000),
        attachments: z.array(attachmentSchema).max(20),
      })
      .strict(),
    output: cardSchema,
  },
  moveCard: {
    input: z.object({ cardId: z.string(), column: columnSchema }).strict(),
    output: cardSchema,
  },
  retryLaunch: {
    input: z.object({ cardId: z.string() }).strict(),
    output: cardSchema,
  },
  setMachine: {
    input: z
      .object({ cardId: z.string(), hostId: z.string().trim().min(1) })
      .strict(),
    output: cardSchema,
  },
  removeCard: {
    input: z.object({ cardId: z.string() }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  showCard: {
    input: z.object({ cardId: z.string() }).strict(),
    output: z.object({ card: cardSchema, history: z.array(historySchema), queued: z.boolean() }).strict(),
  },
});
