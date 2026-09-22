import { z } from "zod";

export const githubCheckSchema = z.object({
  name: z.string(), state: z.enum(["pending", "passed", "failed", "skipped", "cancelled"]), url: z.string().nullable(),
}).strict();

export interface GithubFeedback {
  id: string;
  kind: "review" | "inline" | "comment";
  author: string;
  body: string;
  url: string;
  commitSha: string | null;
  state: string | null;
  updatedAt: number;
  inReplyTo: string | null;
}

export interface GithubSnapshot {
  url: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  author: string;
  checks: z.infer<typeof githubCheckSchema>[];
  mergeable: "mergeable" | "conflicting" | "unknown";
  reviewDecision: string | null;
  feedback: GithubFeedback[];
  fetchedAt: number;
}

export const githubStatusSchema = z.object({
  url: z.string(), number: z.number().int().positive().nullable(), state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(), headSha: z.string(), checks: z.array(githubCheckSchema),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]), reviewDecision: z.string().nullable(),
  review: z.enum(["waiting", "feedback", "clear", "unknown"]),
  followup: z.enum(["pending", "queued", "delivered", "handled", "cancelled"]).nullable(),
  batchId: z.string().nullable(), syncedAt: z.number().nullable(), error: z.string().nullable(),
}).strict();

export type GithubStatus = z.infer<typeof githubStatusSchema>;
export type ReviewDecision = "feedback" | "clear" | "waiting" | "unknown";
export interface ReviewClassification { decision: ReviewDecision; probability: number | null }

export interface ReviewBatch {
  id: string;
  headSha: string;
  feedback: GithubFeedback[];
  threadId: string | null;
  queueId: string | null;
  state: "pending" | "sending" | "queued" | "delivered" | "handled" | "cancelled";
}

export interface GithubSyncState {
  status: GithubStatus;
  observed: Record<string, string>;
  batch: ReviewBatch | null;
  requestedSha: string | null;
  awaitingReview: boolean;
}
