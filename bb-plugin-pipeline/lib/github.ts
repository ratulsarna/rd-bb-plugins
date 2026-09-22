import { z } from "zod";
import type { GithubFeedback, GithubSnapshot } from "./github-types";
import { runGh } from "./gh";

type GithubCheck = GithubSnapshot["checks"][number];

const MAX_PAGES = 100;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

const actorSchema = z.object({ login: z.string().min(1) }).nullable();
const webUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
});
const pageInfoSchema = z.object({
  endCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

const metadataSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        author: actorSchema,
        headRefOid: z.string().regex(SHA_PATTERN),
        isDraft: z.boolean(),
        mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
        number: z.number().int().positive(),
        reviewDecision: z.string().nullable(),
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        url: z.string().url(),
      }).nullable(),
    }).nullable(),
  }),
  errors: z.array(z.unknown()).optional(),
});

const reviewSchema = z.object({
  author: actorSchema,
  body: z.string(),
  commit: z.object({ oid: z.string().regex(SHA_PATTERN) }).nullable(),
  id: z.string().min(1),
  state: z.string().min(1),
  submittedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  url: z.string().url(),
});

const inlineCommentSchema = z.object({
  author: actorSchema,
  body: z.string(),
  commit: z.object({ oid: z.string().regex(SHA_PATTERN) }).nullable(),
  id: z.string().min(1),
  replyTo: z.object({ id: z.string().min(1) }).nullable(),
  updatedAt: z.string().datetime(),
  url: z.string().url(),
});

const commentSchema = z.object({
  author: actorSchema,
  body: z.string(),
  id: z.string().min(1),
  updatedAt: z.string().datetime(),
  url: z.string().url(),
});

const checkRunSchema = z.object({
  __typename: z.literal("CheckRun"),
  conclusion: z.string().nullable(),
  detailsUrl: webUrlSchema.nullable(),
  name: z.string().min(1),
  status: z.string().min(1),
});

const statusContextSchema = z.object({
  __typename: z.literal("StatusContext"),
  context: z.string().min(1),
  state: z.string().min(1),
  targetUrl: webUrlSchema.nullable(),
});

const connectionEnvelopeSchema = z.object({
  data: z.unknown(),
  errors: z.array(z.unknown()).optional(),
});

const METADATA_QUERY = `
query PullRequestMetadata($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      author { login }
      headRefOid
      isDraft
      mergeable
      number
      reviewDecision
      state
      url
    }
  }
}`;

const REVIEWS_QUERY = `
query PullRequestReviews($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $endCursor) {
        nodes { author { login } body commit { oid } id state submittedAt updatedAt url }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`;

const INLINE_COMMENTS_QUERY = `
query PullRequestInlineComments($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          comments(first: 100) {
            nodes { author { login } body commit { oid } id replyTo { id } updatedAt url }
            totalCount
          }
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`;

const COMMENTS_QUERY = `
query PullRequestComments($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: 100, after: $endCursor) {
        nodes { author { login } body id updatedAt url }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`;

const CHECKS_QUERY = `
query PullRequestChecks($owner: String!, $repo: String!, $head: GitObjectID!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    object(oid: $head) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $endCursor) {
            nodes {
              __typename
              ... on CheckRun { conclusion detailsUrl name status }
              ... on StatusContext { context state targetUrl }
            }
            pageInfo { endCursor hasNextPage }
          }
        }
      }
    }
  }
}`;

interface PullRequestLocation {
  normalized: string;
  number: number;
  owner: string;
  repo: string;
}

interface Metadata {
  author: string;
  draft: boolean;
  headSha: string;
  mergeable: GithubSnapshot["mergeable"];
  number: number;
  reviewDecision: string | null;
  state: GithubSnapshot["state"];
  url: string;
}

export function normalizePullRequestUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  const match = url.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/,
  );
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    return null;
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  return `https://github.com/${match[1]}/${match[2]}/pull/${number}`;
}

function parseLocation(value: string): PullRequestLocation {
  const normalized = normalizePullRequestUrl(value);
  if (normalized === null) throw new Error("expected a github.com pull request URL");
  const [, owner, repo, , numberText] = new URL(normalized).pathname.split("/");
  return { normalized, number: Number(numberText), owner, repo };
}

function apiArgs(
  query: string,
  location: PullRequestLocation,
  fields: readonly string[] = [],
  includeNumber = true,
): string[] {
  return [
    "api",
    "graphql",
    "--hostname",
    "github.com",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${location.owner}`,
    "-f",
    `repo=${location.repo}`,
    ...(includeNumber ? ["-F", `number=${location.number}`] : []),
    ...fields,
  ];
}

function feedbackUrl(value: string, location: PullRequestLocation): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== new URL(location.normalized).pathname
  ) {
    throw new Error("GitHub returned an invalid feedback URL");
  }
  return value;
}

function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("GitHub returned an invalid timestamp");
  return result;
}

function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`gh returned invalid JSON for ${description}`);
  }
}

function assertNoGraphqlErrors(value: { errors?: unknown[] }, description: string): void {
  if (value.errors !== undefined && value.errors.length > 0) {
    throw new Error(`GitHub returned GraphQL errors for ${description}`);
  }
}

async function readMetadata(location: PullRequestLocation, signal?: AbortSignal): Promise<Metadata> {
  const raw = parseJson(await runGh(apiArgs(METADATA_QUERY, location), signal), "pull request metadata");
  const result = metadataSchema.safeParse(raw);
  if (!result.success) throw new Error("GitHub returned invalid pull request metadata");
  assertNoGraphqlErrors(result.data, "pull request metadata");
  const pullRequest = result.data.data.repository?.pullRequest;
  if (pullRequest === null || pullRequest === undefined) throw new Error("pull request was not found");
  if (
    normalizePullRequestUrl(pullRequest.url)?.toLowerCase() !== location.normalized.toLowerCase() ||
    pullRequest.number !== location.number
  ) {
    throw new Error("GitHub returned metadata for a different pull request");
  }
  return {
    author: pullRequest.author?.login ?? "ghost",
    draft: pullRequest.isDraft,
    headSha: pullRequest.headRefOid.toLowerCase(),
    mergeable: pullRequest.mergeable.toLowerCase() as Metadata["mergeable"],
    number: pullRequest.number,
    reviewDecision: pullRequest.reviewDecision,
    state: pullRequest.state.toLowerCase() as Metadata["state"],
    url: location.normalized,
  };
}

async function readPages(
  query: string,
  location: PullRequestLocation,
  description: string,
  signal: AbortSignal | undefined,
  fields: readonly string[] = [],
  includeNumber = true,
): Promise<unknown[]> {
  const args = apiArgs(query, location, fields, includeNumber);
  args.splice(2, 0, "--paginate", "--slurp");
  const raw = parseJson(await runGh(args, signal), description);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PAGES) {
    throw new Error(`GitHub returned an invalid or oversized page set for ${description}`);
  }
  return raw;
}

function validatePages<T>(
  rawPages: unknown[],
  description: string,
  extract: (data: unknown) => { nodes: unknown[]; pageInfo: z.infer<typeof pageInfoSchema> } | null,
  nodeSchema: z.ZodType<T>,
): T[] {
  const result: T[] = [];
  for (const [index, rawPage] of rawPages.entries()) {
    const envelope = connectionEnvelopeSchema.safeParse(rawPage);
    if (!envelope.success) throw new Error(`GitHub returned invalid ${description}`);
    assertNoGraphqlErrors(envelope.data, description);
    const connection = extract(envelope.data.data);
    if (connection === null) {
      if (rawPages.length === 1) return [];
      throw new Error(`GitHub returned inconsistent pagination for ${description}`);
    }
    const pageInfo = pageInfoSchema.safeParse(connection.pageInfo);
    if (!pageInfo.success) throw new Error(`GitHub returned invalid pagination for ${description}`);
    const isLast = index === rawPages.length - 1;
    if (pageInfo.data.hasNextPage === isLast || (!isLast && pageInfo.data.endCursor === null)) {
      throw new Error(`GitHub did not return every page of ${description}`);
    }
    const nodes = z.array(nodeSchema.nullable()).safeParse(connection.nodes);
    if (!nodes.success) throw new Error(`GitHub returned invalid ${description}`);
    result.push(...nodes.data.filter((node): node is T => node !== null));
  }
  return result;
}

function pullRequestConnection(data: unknown, field: string) {
  const root = z.object({ repository: z.object({ pullRequest: z.record(z.string(), z.unknown()).nullable() }).nullable() })
    .safeParse(data);
  if (!root.success) throw new Error("GitHub returned an invalid pull request connection");
  const pullRequest = root.data.repository?.pullRequest;
  if (pullRequest === null || pullRequest === undefined) {
    throw new Error("GitHub returned an invalid pull request connection");
  }
  const value = pullRequest[field];
  if (value === null || value === undefined) throw new Error("GitHub returned an invalid pull request connection");
  const parsed = z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema }).safeParse(value);
  if (!parsed.success) throw new Error("GitHub returned an invalid pull request connection");
  return parsed.data;
}

async function readReviews(location: PullRequestLocation, signal?: AbortSignal): Promise<GithubFeedback[]> {
  const pages = await readPages(REVIEWS_QUERY, location, "reviews", signal);
  return validatePages(pages, "reviews", (data) => pullRequestConnection(data, "reviews"), reviewSchema)
    .filter((review) => review.submittedAt !== null)
    .map((review) => ({
      id: review.id,
      kind: "review",
      author: review.author?.login ?? "ghost",
      body: review.body,
      url: feedbackUrl(review.url, location),
      commitSha: review.commit?.oid.toLowerCase() ?? null,
      state: review.state,
      updatedAt: timestamp(review.updatedAt),
      inReplyTo: null,
    }));
}

function inlineConnection(data: unknown) {
  const root = z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(z.object({
            comments: z.object({
              nodes: z.array(z.unknown()),
              totalCount: z.number().int().nonnegative(),
            }),
          }).nullable()),
          pageInfo: pageInfoSchema,
        }),
      }).nullable(),
    }).nullable(),
  }).safeParse(data);
  if (!root.success) throw new Error("GitHub returned invalid inline comments");
  const threads = root.data.repository?.pullRequest?.reviewThreads;
  if (threads === undefined) throw new Error("GitHub returned invalid inline comments");
  const nodes: unknown[] = [];
  for (const thread of threads.nodes) {
    if (thread === null) continue;
    if (thread.comments.nodes.length < thread.comments.totalCount) {
      throw new Error("GitHub inline comment thread exceeded the pagination bound");
    }
    nodes.push(...thread.comments.nodes);
  }
  return { nodes, pageInfo: threads.pageInfo };
}

async function readInlineComments(location: PullRequestLocation, signal?: AbortSignal): Promise<GithubFeedback[]> {
  const pages = await readPages(INLINE_COMMENTS_QUERY, location, "inline comments", signal);
  return validatePages(pages, "inline comments", inlineConnection, inlineCommentSchema).map((comment) => ({
    id: comment.id,
    kind: "inline",
    author: comment.author?.login ?? "ghost",
    body: comment.body,
    url: feedbackUrl(comment.url, location),
    commitSha: comment.commit?.oid.toLowerCase() ?? null,
    state: null,
    updatedAt: timestamp(comment.updatedAt),
    inReplyTo: comment.replyTo?.id ?? null,
  }));
}

async function readComments(location: PullRequestLocation, signal?: AbortSignal): Promise<GithubFeedback[]> {
  const pages = await readPages(COMMENTS_QUERY, location, "comments", signal);
  return validatePages(pages, "comments", (data) => pullRequestConnection(data, "comments"), commentSchema)
    .map((comment) => ({
      id: comment.id,
      kind: "comment",
      author: comment.author?.login ?? "ghost",
      body: comment.body,
      url: feedbackUrl(comment.url, location),
      commitSha: null,
      state: null,
      updatedAt: timestamp(comment.updatedAt),
      inReplyTo: null,
    }));
}

function checkConnection(data: unknown) {
  const root = z.object({
    repository: z.object({
      object: z.object({
        statusCheckRollup: z.object({
          contexts: z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema }),
        }).nullable(),
      }).nullable(),
    }).nullable(),
  }).safeParse(data);
  if (!root.success) throw new Error("GitHub returned invalid checks");
  const object = root.data.repository?.object;
  if (object === null || object === undefined) throw new Error("GitHub returned invalid checks");
  return object.statusCheckRollup?.contexts ?? null;
}

function checkRunState(status: string, conclusion: string | null): GithubCheck["state"] {
  if (status !== "COMPLETED") return "pending";
  if (conclusion === "SUCCESS") return "passed";
  if (conclusion === "SKIPPED" || conclusion === "NEUTRAL") return "skipped";
  if (conclusion === "CANCELLED" || conclusion === "STALE") return "cancelled";
  if (conclusion === null) return "pending";
  return "failed";
}

function statusContextState(state: string): GithubCheck["state"] {
  if (state === "SUCCESS") return "passed";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "failed";
}

async function readChecks(
  location: PullRequestLocation,
  headSha: string,
  signal?: AbortSignal,
): Promise<GithubCheck[]> {
  const pages = await readPages(
    CHECKS_QUERY,
    location,
    "checks",
    signal,
    ["-f", `head=${headSha}`],
    false,
  );
  const nodes = validatePages(
    pages,
    "checks",
    checkConnection,
    z.discriminatedUnion("__typename", [checkRunSchema, statusContextSchema]),
  );
  return nodes.map((check) => check.__typename === "CheckRun"
    ? { name: check.name, state: checkRunState(check.status, check.conclusion), url: check.detailsUrl }
    : { name: check.context, state: statusContextState(check.state), url: check.targetUrl });
}

export async function readPullRequest(url: string, signal?: AbortSignal): Promise<GithubSnapshot> {
  const location = parseLocation(url);
  try {
    const before = await readMetadata(location, signal);
    const [checks, reviews, inlineComments, comments] = await Promise.all([
      readChecks(location, before.headSha, signal),
      readReviews(location, signal),
      readInlineComments(location, signal),
      readComments(location, signal),
    ]);
    const after = await readMetadata(location, signal);
    if (before.headSha !== after.headSha) {
      throw new Error(`pull request head changed from ${before.headSha} to ${after.headSha} while reading it`);
    }
    return {
      url: after.url,
      number: after.number,
      state: after.state,
      draft: after.draft,
      headSha: after.headSha,
      author: after.author,
      checks,
      mergeable: after.mergeable,
      reviewDecision: after.reviewDecision,
      feedback: [...reviews, ...inlineComments, ...comments]
        .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id)),
      fetchedAt: Date.now(),
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not read ${location.normalized}: ${message}`);
  }
}

export async function postReviewRequest(url: string, body: string, signal?: AbortSignal): Promise<void> {
  const location = parseLocation(url);
  try {
    await runGh([
      "api",
      `repos/${location.owner}/${location.repo}/issues/${location.number}/comments`,
      "--hostname",
      "github.com",
      "--method",
      "POST",
      "--raw-field",
      `body=${body}`,
      "--silent",
    ], signal);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not post review request to ${location.normalized}: ${message}`);
  }
}
