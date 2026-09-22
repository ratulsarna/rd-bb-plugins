import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGh } from "../lib/gh";
import { normalizePullRequestUrl, postReviewRequest, readPullRequest } from "../lib/github";

vi.mock("../lib/gh", () => ({ runGh: vi.fn() }));

const mockedRunGh = vi.mocked(runGh);
const URL = "https://github.com/acme/widgets/pull/42";
const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const REVIEWED_HEAD = "c".repeat(40);

function queryFrom(args: readonly string[]): string {
  return args.find((arg) => arg.startsWith("query=")) ?? "";
}

function metadata(head = HEAD) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          author: { login: "octocat" },
          headRefOid: head,
          isDraft: false,
          mergeable: "MERGEABLE",
          number: 42,
          reviewDecision: "CHANGES_REQUESTED",
          state: "OPEN",
          url: URL,
        },
      },
    },
  });
}

function paged(field: string, nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      repository: {
        pullRequest: {
          [field]: { nodes, pageInfo: { hasNextPage, endCursor } },
        },
      },
    },
  };
}

function inlinePage(nodes: unknown[] = [], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } },
        },
      },
    },
  };
}

function checkPage(nodes: unknown[] = [], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      repository: {
        object: {
          statusCheckRollup: {
            contexts: { nodes, pageInfo: { hasNextPage, endCursor } },
          },
        },
      },
    },
  };
}

function installResponses(overrides: {
  checks?: unknown[];
  comments?: unknown[];
  inline?: unknown[];
  reviews?: unknown[];
  metadataHeads?: string[];
} = {}) {
  let metadataCall = 0;
  mockedRunGh.mockImplementation(async (args) => {
    const query = queryFrom(args);
    if (query.includes("PullRequestMetadata")) {
      return metadata(overrides.metadataHeads?.[metadataCall++] ?? HEAD);
    }
    if (query.includes("PullRequestChecks")) {
      return JSON.stringify(overrides.checks ?? [checkPage()]);
    }
    if (query.includes("PullRequestReviews")) {
      return JSON.stringify(overrides.reviews ?? [paged("reviews", [])]);
    }
    if (query.includes("PullRequestInlineComments")) {
      return JSON.stringify(overrides.inline ?? [inlinePage()]);
    }
    if (query.includes("PullRequestComments")) {
      return JSON.stringify(overrides.comments ?? [paged("comments", [])]);
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  });
}

beforeEach(() => {
  mockedRunGh.mockReset();
});

describe("normalizePullRequestUrl", () => {
  it("canonicalizes GitHub PR tabs, query strings, fragments, and trailing slashes", () => {
    expect(normalizePullRequestUrl(`${URL}/files/?diff=split#discussion_r1`)).toBe(URL);
    expect(normalizePullRequestUrl("https://GITHUB.com/acme/widgets/pull/42")).toBe(URL);
  });

  it.each([
    "http://github.com/acme/widgets/pull/42",
    "https://token@github.com/acme/widgets/pull/42",
    "https://github.com.evil.test/acme/widgets/pull/42",
    "https://github.com:444/acme/widgets/pull/42",
    "https://github.com/acme/widgets/issues/42",
    "https://github.com/acme/widgets/pull/42.patch",
    "https://github.com/acme%2Fevil/widgets/pull/42",
    "https://github.com/acme/widgets/pull/42/files/../../settings",
    "https://github.com/acme/widgets/pull/0",
    "not a url; gh auth token",
  ])("rejects a malformed, non-PR, or credential-bearing URL: %s", (url) => {
    expect(normalizePullRequestUrl(url)).toBeNull();
  });

  it("does not invoke gh for rejected input", async () => {
    await expect(readPullRequest("https://evil.test/acme/widgets/pull/42"))
      .rejects.toThrow("expected a github.com pull request URL");
    expect(mockedRunGh).not.toHaveBeenCalled();
  });
});

describe("readPullRequest", () => {
  it("paginates every feedback collection and preserves edited, commit, reply, and state data", async () => {
    installResponses({
      reviews: [
        paged("reviews", [{
          author: { login: "reviewer" },
          body: "old page, edited body",
          commit: { oid: REVIEWED_HEAD },
          id: "PRR_review",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-09-20T10:00:00Z",
          updatedAt: "2026-09-21T10:00:00Z",
          url: `${URL}#pullrequestreview-1`,
        }], true, "reviews-1"),
        paged("reviews", [{
          author: null,
          body: "approved",
          commit: { oid: HEAD },
          id: "PRR_approved",
          state: "APPROVED",
          submittedAt: "2026-09-21T11:00:00Z",
          updatedAt: "2026-09-21T11:00:00Z",
          url: `${URL}#pullrequestreview-2`,
        }, {
          author: { login: "draft-reviewer" },
          body: "not submitted",
          commit: { oid: HEAD },
          id: "PRR_pending",
          state: "PENDING",
          submittedAt: null,
          updatedAt: "2026-09-21T11:30:00Z",
          url: `${URL}#pullrequestreview-3`,
        }]),
      ],
      inline: [
        inlinePage([{ comments: {
          nodes: [{
            author: { login: "inline-reviewer" },
            body: "please rename this",
            commit: { oid: REVIEWED_HEAD },
            id: "PRRC_parent",
            replyTo: null,
            updatedAt: "2026-09-21T12:00:00Z",
            url: `${URL}#discussion_r1`,
          }],
          totalCount: 1,
        } }], true, "threads-1"),
        inlinePage([{ comments: {
          nodes: [{
            author: { login: "author" },
            body: "fixed",
            commit: { oid: HEAD },
            id: "PRRC_reply",
            replyTo: { id: "PRRC_parent" },
            updatedAt: "2026-09-21T13:00:00Z",
            url: `${URL}#discussion_r2`,
          }],
          totalCount: 1,
        } }]),
      ],
      comments: [
        paged("comments", [{
          author: { login: "maintainer" },
          body: "general feedback",
          id: "IC_comment",
          updatedAt: "2026-09-21T14:00:00Z",
          url: `${URL}#issuecomment-1`,
        }], true, "comments-1"),
        paged("comments", []),
      ],
    });

    const result = await readPullRequest(`${URL}/files#discussion_r1`);

    expect(result).toMatchObject({
      url: URL,
      number: 42,
      state: "open",
      draft: false,
      headSha: HEAD,
      author: "octocat",
      mergeable: "mergeable",
      reviewDecision: "CHANGES_REQUESTED",
    });
    expect(result.feedback).toEqual([
      expect.objectContaining({
        id: "PRR_review",
        kind: "review",
        author: "reviewer",
        body: "old page, edited body",
        commitSha: REVIEWED_HEAD,
        state: "CHANGES_REQUESTED",
        updatedAt: Date.parse("2026-09-21T10:00:00Z"),
      }),
      expect.objectContaining({ id: "PRR_approved", author: "ghost", commitSha: HEAD }),
      expect.objectContaining({ id: "PRRC_parent", kind: "inline", commitSha: REVIEWED_HEAD }),
      expect.objectContaining({ id: "PRRC_reply", inReplyTo: "PRRC_parent", commitSha: HEAD }),
      expect.objectContaining({ id: "IC_comment", kind: "comment", commitSha: null }),
    ]);
    expect(result.feedback.map(({ id }) => id)).not.toContain("PRR_pending");
    const paginatedCalls = mockedRunGh.mock.calls.filter(([args]) => args.includes("--paginate"));
    expect(paginatedCalls).toHaveLength(4);
    expect(paginatedCalls.every(([args]) => args.includes("--slurp"))).toBe(true);
    expect(paginatedCalls.every(([args]) => args.indexOf("--paginate") < args.indexOf("--hostname"))).toBe(true);
  });

  it("maps failed and pending checks without treating either as passed", async () => {
    installResponses({
      checks: [checkPage([
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/acme/widgets/actions/runs/1",
          name: "test",
          status: "COMPLETED",
        },
        {
          __typename: "CheckRun",
          conclusion: null,
          detailsUrl: null,
          name: "build",
          status: "IN_PROGRESS",
        },
        {
          __typename: "StatusContext",
          context: "legacy-ci",
          state: "ERROR",
          targetUrl: "https://github.com/acme/widgets/runs/legacy",
        },
      ])],
    });

    await expect(readPullRequest(URL)).resolves.toMatchObject({
      checks: [
        { name: "test", state: "failed" },
        { name: "build", state: "pending" },
        { name: "legacy-ci", state: "failed" },
      ],
    });
  });

  it("returns an empty check list when the head has no check rollup", async () => {
    installResponses({
      checks: [{ data: { repository: { object: { statusCheckRollup: null } } } }],
    });
    await expect(readPullRequest(URL)).resolves.toMatchObject({ checks: [] });
  });

  it("rejects unsafe links in external check data", async () => {
    installResponses({
      checks: [checkPage([{
        __typename: "StatusContext",
        context: "hostile-ci",
        state: "SUCCESS",
        targetUrl: "javascript:alert(1)",
      }])],
    });
    await expect(readPullRequest(URL)).rejects.toThrow("GitHub returned invalid checks");
  });

  it("fails visibly instead of truncating an oversized inline thread", async () => {
    installResponses({
      inline: [inlinePage([{ comments: {
        nodes: [],
        totalCount: 101,
      } }])],
    });
    await expect(readPullRequest(URL)).rejects.toThrow("inline comment thread exceeded the pagination bound");
  });

  it("fails the whole snapshot when authentication or one partial fetch fails", async () => {
    installResponses();
    mockedRunGh.mockImplementationOnce(async () => metadata())
      .mockImplementationOnce(async () => { throw new Error("gh failed: authentication required"); });

    await expect(readPullRequest(URL)).rejects.toThrow("authentication required");
  });

  it("rejects feedback fetched across different PR heads", async () => {
    installResponses({ metadataHeads: [HEAD, NEXT_HEAD] });
    await expect(readPullRequest(URL)).rejects.toThrow(`head changed from ${HEAD} to ${NEXT_HEAD}`);
  });

  it("forwards an abort signal to every gh request", async () => {
    installResponses();
    const controller = new AbortController();
    await readPullRequest(URL, controller.signal);
    expect(mockedRunGh.mock.calls.length).toBeGreaterThan(0);
    expect(mockedRunGh.mock.calls.every(([, signal]) => signal === controller.signal)).toBe(true);
  });
});

describe("postReviewRequest", () => {
  it("posts the exact body as one raw field through the bounded runner", async () => {
    mockedRunGh.mockResolvedValue("");
    const signal = new AbortController().signal;
    const body = "@codex review\n\n<!-- pipeline:head=a; $(do-not-run) -->";

    await postReviewRequest(`${URL}?notification_referrer_id=1`, body, signal);

    expect(mockedRunGh).toHaveBeenCalledWith([
      "api",
      "repos/acme/widgets/issues/42/comments",
      "--hostname",
      "github.com",
      "--method",
      "POST",
      "--raw-field",
      `body=${body}`,
      "--silent",
    ], signal);
  });

  it("rejects unsafe targets before invoking gh", async () => {
    await expect(postReviewRequest("https://example.com/acme/widgets/pull/42", "@codex review"))
      .rejects.toThrow("expected a github.com pull request URL");
    expect(mockedRunGh).not.toHaveBeenCalled();
  });
});
