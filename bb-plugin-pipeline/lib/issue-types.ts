import { z } from "zod";

export const githubIssueCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  url: z.string().url(),
  createdAt: z.string(),
});

export type GithubIssueComment = z.infer<typeof githubIssueCommentSchema>;

export const githubIssueSummarySchema = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  updatedAt: z.string(),
});

export type GithubIssueSummary = z.infer<typeof githubIssueSummarySchema>;

export const githubIssueDetailsSchema = githubIssueSummarySchema.extend({
  body: z.string(),
  comments: z.array(githubIssueCommentSchema),
});

export type GithubIssueDetails = z.infer<typeof githubIssueDetailsSchema>;

export const importedIssueSchema = githubIssueDetailsSchema.extend({
  importedBy: z.string(),
  syncedAt: z.number(),
  error: z.string().nullable(),
});

export type ImportedIssue = z.infer<typeof importedIssueSchema>;
