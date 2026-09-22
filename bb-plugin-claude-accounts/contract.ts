import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const identitySchema = z.object({
  email: z.string().nullable(),
  organization: z.string().nullable(),
});
export const loginSchema = z.object({
  id: z.string(),
  phase: z.enum([
    "starting",
    "awaiting-code",
    "verifying",
    "success",
    "error",
    "cancelled",
    "expired",
  ]),
  url: z.string().nullable(),
  message: z.string(),
  expiresAt: z.number(),
});
export type Login = z.infer<typeof loginSchema>;
export const probeSchema = z.object({
  available: z.boolean(),
  identity: identitySchema.nullable(),
  issue: z.string().nullable(),
  login: loginSchema.nullable(),
});
export type Probe = z.infer<typeof probeSchema>;
export const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(
    /^[A-Za-z0-9._~+\/=\#-]+$/,
    "Paste only the code from Claude's login page.",
  );
export const hostContract = defineRpcContract({
  inspect: { input: z.object({ refresh: z.boolean() }), output: probeSchema },
  start: { input: z.object({}), output: loginSchema },
  submit: {
    input: z.object({ id: z.string(), code: codeSchema }),
    output: loginSchema,
  },
  cancel: { input: z.object({ id: z.string() }), output: loginSchema },
});
export const machineSchema = probeSchema.extend({
  hostId: z.string(),
  name: z.string(),
  connected: z.boolean(),
});
export type Machine = z.infer<typeof machineSchema>;
export const rpcContract = defineRpcContract({
  list: {
    input: z.object({ refresh: z.boolean().default(false) }),
    output: z.object({
      machines: z.array(machineSchema),
    }),
  },
  start: {
    input: z.object({
      hostIds: z.array(z.string()).min(1).max(20),
    }),
    output: z.array(
      z.object({
        hostId: z.string(),
        login: loginSchema.nullable(),
        error: z.string().nullable(),
      }),
    ),
  },
  submit: {
    input: z.object({ hostId: z.string(), id: z.string(), code: codeSchema }),
    output: loginSchema,
  },
  cancel: {
    input: z.object({ hostId: z.string(), id: z.string() }),
    output: loginSchema,
  },
});
