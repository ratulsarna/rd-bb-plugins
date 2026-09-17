import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadIdInput = z.object({ threadId: z.string().trim().min(1) });

/**
 * The Bots section's RPC surface, ported from the inbox-sidebar plugin.
 *
 * The stateless halves (seeds, avatars, replacement) are implemented here
 * against bb.sdk directly. The two stateful halves (subtitles, order) are
 * proxied to the inbox-sidebar plugin, which owns their tables, so both
 * sidebars read and write one source of truth.
 */
export const botsRpcContract = defineRpcContract({
  assistantSeeds: {
    input: threadIdInput,
    output: z.object({
      title: z.string().nullable(),
      projectId: z.string(),
      environmentId: z.string(),
      providerId: z.string(),
      model: z.string().optional(),
      reasoningLevel: z.string().optional(),
      permissionMode: z.string().optional(),
      serviceTier: z.string().optional(),
      homePath: z.string().nullable(),
      homes: z.array(z.object({ name: z.string(), path: z.string() })),
      targetingAutomations: z.array(
        z.object({ id: z.string(), name: z.string() }),
      ),
    }),
  },
  listAssistantAvatars: {
    input: z.object({
      environmentIds: z.array(z.string().trim().min(1)).max(100),
    }),
    output: z.object({
      rows: z.array(
        z.object({ environmentId: z.string(), svg: z.string() }),
      ),
    }),
  },
  createReplacementThread: {
    input: z.object({
      replaceThreadId: z.string().trim().min(1),
      title: z.string().nullable(),
      request: z.unknown(),
      homePath: z.string().trim().min(1).optional(),
    }),
    output: z.object({ newThreadId: z.string() }),
  },
  listAssistantSubtitles: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({ environmentId: z.string(), subtitle: z.string() }),
      ),
    }),
  },
  setAssistantSubtitle: {
    input: z.object({
      threadId: z.string().trim().min(1),
      subtitle: z.string().trim().max(200),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  assistantOrder: {
    input: z.object({}),
    output: z.object({ ids: z.array(z.string()) }),
  },
  setAssistantOrder: {
    input: z.object({
      environmentIds: z.array(z.string().trim().min(1)).max(200),
    }),
    output: z.object({ ids: z.array(z.string()) }),
  },
});
