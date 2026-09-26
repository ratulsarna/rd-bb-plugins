import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGh } from "../lib/gh";
import {
  githubRepository, listAssignedIssues, normalizeGithubIssueUrl,
  readGithubIssue, readGithubViewer, readIssue,
} from "../lib/issue";

vi.mock("../lib/gh", () => ({ runGh: vi.fn() }));

const mockedRunGh = vi.mocked(runGh);

const REPO = "acme/widgets";
const BASE = "https://github.com/acme/widgets";

interface Call {
  route: string;
  query: URLSearchParams;
  paginate: boolean;
  args: readonly string[];
}

function parseCall(args: readonly string[]): Call {
  const path = args.find((arg) => arg === "user" || arg.startsWith("repos/"));
  if (path === undefined) throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  const [route, queryString = ""] = path.split("?");
  return {
    route,
    query: new URLSearchParams(queryString),
    paginate: args.includes("--paginate"),
    args,
  };
}

function calls(): Call[] {
  return mockedRunGh.mock.calls.map(([args]) => parseCall(args));
}

function routeGh(handler: (call: Call) => string): void {
  mockedRunGh.mockImplementation(async (args) => handler(parseCall(args)));
}

function restIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const number = typeof overrides.number === "number" ? overrides.number : 7;
  return {
    url: `https://api.github.com/repos/${REPO}/issues/${number}`,
    html_url: `${BASE}/issues/${number}`,
    number,
    title: "Fix the login flow",
    state: "open",
    body: "Steps to reproduce",
    labels: [{ name: "bug" }],
    assignees: [{ login: "octobot" }],
    user: { login: "monalisa" },
    updated_at: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

function restComment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { login: "monalisa" },
    body: "A comment",
    html_url: `${BASE}/issues/7#issuecomment-1`,
    created_at: "2026-09-02T10:00:00Z",
    ...overrides,
  };
}

describe("githubRepository", () => {
  it("parses HTTPS remotes with or without .git and trailing slash", () => {
    expect(githubRepository("https://github.com/acme/widgets.git")).toBe(REPO);
    expect(githubRepository("https://github.com/acme/widgets")).toBe(REPO);
    expect(githubRepository("https://github.com/acme/widgets/")).toBe(REPO);
    expect(githubRepository("https://octobot@github.com/acme/widgets.git")).toBe(REPO);
  });

  it("parses scp-like SSH remotes", () => {
    expect(githubRepository("git@github.com:acme/widgets.git")).toBe(REPO);
    expect(githubRepository("github.com:acme/widgets")).toBe(REPO);
  });

  it("parses ssh:// remotes, with optional user and port 22", () => {
    expect(githubRepository("ssh://git@github.com/acme/widgets.git")).toBe(REPO);
    expect(githubRepository("ssh://github.com/acme/widgets")).toBe(REPO);
    expect(githubRepository("ssh://git@github.com:22/acme/widgets.git")).toBe(REPO);
  });

  it("matches the host case-insensitively but keeps owner/repo case", () => {
    expect(githubRepository("git@GitHub.com:Acme/Widgets.Raw.git")).toBe("Acme/Widgets.Raw");
  });

  it("rejects a missing remote", () => {
    expect(() => githubRepository(null)).toThrow(/no git remote URL/);
    expect(() => githubRepository("")).toThrow(/no git remote URL/);
    expect(() => githubRepository("   ")).toThrow(/no git remote URL/);
  });

  it("rejects non-github hosts, plain HTTP, other schemes, and credentials", () => {
    expect(() => githubRepository("https://gitlab.com/acme/widgets.git")).toThrow(/must point at github\.com/);
    expect(() => githubRepository("git@gitlab.com:acme/widgets.git")).toThrow(/must point at github\.com/);
    expect(() => githubRepository("http://github.com/acme/widgets")).toThrow(/must point at github\.com/);
    expect(() => githubRepository("https://user:token@github.com/acme/widgets")).toThrow(/must point at github\.com/);
    expect(() => githubRepository("https://user:secret-value@github.com/acme/widgets")).not.toThrow(/secret-value/);
    expect(() => githubRepository("file:///srv/repo")).toThrow(/must point at github\.com/);
    expect(() => githubRepository("ssh://git@github.com:2222/acme/widgets.git"))
      .toThrow(/must point at github\.com/);
  });

  it("rejects remotes without an owner/repo path", () => {
    expect(() => githubRepository("https://github.com/acme")).toThrow(/owner\/repo/);
    expect(() => githubRepository("git@github.com:acme")).toThrow(/must point at github\.com/);
    expect(() => githubRepository("https://github.com/")).toThrow(/owner\/repo/);
    expect(() => githubRepository("git@github.com:../etc")).toThrow(/owner\/repo/);
  });
});

describe("normalizeGithubIssueUrl", () => {
  it("keeps canonical URLs and preserves path case", () => {
    expect(normalizeGithubIssueUrl("https://github.com/acme/widgets/issues/7")).toBe(`${BASE}/issues/7`);
    expect(normalizeGithubIssueUrl("https://github.com/Acme/Widgets/issues/7"))
      .toBe("https://github.com/Acme/Widgets/issues/7");
  });

  it("canonicalizes trailing slashes and harmless fragments to the same identity", () => {
    expect(normalizeGithubIssueUrl(`${BASE}/issues/7/`)).toBe(`${BASE}/issues/7`);
    expect(normalizeGithubIssueUrl(`${BASE}/issues/7#issuecomment-123`)).toBe(`${BASE}/issues/7`);
    expect(normalizeGithubIssueUrl("https://GITHUB.com/acme/widgets/issues/7/#frag"))
      .toBe(`${BASE}/issues/7`);
  });

  it("rejects pull request URLs", () => {
    expect(normalizeGithubIssueUrl(`${BASE}/pull/7`)).toBeNull();
  });

  it("rejects queries, credentials, ports, and non-https schemes", () => {
    expect(normalizeGithubIssueUrl(`${BASE}/issues/7?foo=bar`)).toBeNull();
    expect(normalizeGithubIssueUrl("https://user:token@github.com/acme/widgets/issues/7")).toBeNull();
    expect(normalizeGithubIssueUrl("https://github.com:8443/acme/widgets/issues/7")).toBeNull();
    expect(normalizeGithubIssueUrl("http://github.com/acme/widgets/issues/7")).toBeNull();
    expect(normalizeGithubIssueUrl("https://gitlab.com/acme/widgets/issues/7")).toBeNull();
  });

  it("rejects invalid issue numbers and paths", () => {
    expect(normalizeGithubIssueUrl(`${BASE}/issues/0`)).toBeNull();
    expect(normalizeGithubIssueUrl(`${BASE}/issues/007`)).toBeNull();
    expect(normalizeGithubIssueUrl(`${BASE}/issues/abc`)).toBeNull();
    expect(normalizeGithubIssueUrl(`${BASE}/issues/99999999999999999999`)).toBeNull();
    expect(normalizeGithubIssueUrl(`${BASE}/issues/7/title`)).toBeNull();
    expect(normalizeGithubIssueUrl(`${BASE}/issues/`)).toBeNull();
  });

  it("rejects values that are not URLs", () => {
    expect(normalizeGithubIssueUrl("not a url")).toBeNull();
    expect(normalizeGithubIssueUrl("")).toBeNull();
    expect(normalizeGithubIssueUrl("//acme/widgets/issues/7")).toBeNull();
  });
});

describe("readGithubViewer", () => {
  beforeEach(() => {
    mockedRunGh.mockReset();
  });

  it("returns the login from gh api user on github.com", async () => {
    routeGh((call) => {
      expect(call.route).toBe("user");
      expect(call.args).toContain("github.com");
      return JSON.stringify({ login: "octobot" });
    });
    await expect(readGithubViewer()).resolves.toBe("octobot");
  });

  it("wraps gh failures", async () => {
    mockedRunGh.mockRejectedValue(new Error("gh failed: auth expired"));
    await expect(readGithubViewer()).rejects.toThrow(/could not read the GitHub account.*auth expired/s);
  });

  it("rejects invalid login data", async () => {
    mockedRunGh.mockResolvedValue(JSON.stringify({ login: "has spaces" }));
    await expect(readGithubViewer()).rejects.toThrow(/could not read the GitHub account/);
    mockedRunGh.mockResolvedValue(JSON.stringify({}));
    await expect(readGithubViewer()).rejects.toThrow(/could not read the GitHub account/);
    mockedRunGh.mockResolvedValue("not json");
    await expect(readGithubViewer()).rejects.toThrow(/could not read the GitHub account/);
  });
});

describe("listAssignedIssues", () => {
  beforeEach(() => {
    mockedRunGh.mockReset();
  });

  it("lists open issues assigned to the viewer, skipping pull requests", async () => {
    routeGh((call) => {
      expect(call.route).toBe(`repos/${REPO}/issues`);
      expect(call.query.get("state")).toBe("open");
      expect(call.query.get("assignee")).toBe("octobot");
      expect(call.query.get("per_page")).toBe("50");
      expect(call.query.get("page")).toBe("1");
      expect(call.query.get("sort")).toBe("updated");
      expect(call.paginate).toBe(false);
      return JSON.stringify([
        restIssue(),
        restIssue({ number: 9, labels: [], assignees: null }),
        restIssue({ number: 11, html_url: `${BASE}/pull/11`, pull_request: { html_url: `${BASE}/pull/11` } }),
      ]);
    });
    const result = await listAssignedIssues(REPO, "octobot", 1);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toEqual({
      url: `${BASE}/issues/7`,
      number: 7,
      title: "Fix the login flow",
      state: "open",
      labels: ["bug"],
      assignees: ["octobot"],
      updatedAt: "2026-09-01T10:00:00Z",
    });
    expect(result.issues[1]).toMatchObject({ number: 9, labels: [], assignees: [] });
    expect(result.hasMore).toBe(false);
    expect(calls()).toHaveLength(1);
  });

  it("reports hasMore from the raw page size, with a single gh call", async () => {
    const full = Array.from({ length: 50 }, (_, index) => restIssue({ number: index + 1 }));
    routeGh(() => JSON.stringify(full));
    await expect(listAssignedIssues(REPO, "octobot", 1)).resolves.toMatchObject({
      hasMore: true, issues: { length: 50 },
    });
    expect(calls()).toHaveLength(1);

    mockedRunGh.mockReset();
    routeGh(() => JSON.stringify(full.slice(0, 49)));
    await expect(listAssignedIssues(REPO, "octobot", 2)).resolves.toMatchObject({ hasMore: false });
    expect(calls()).toHaveLength(1);
  });

  it("keeps pagination working when a full page is partly pull requests", async () => {
    const page = Array.from({ length: 50 }, (_, index) =>
      index < 3
        ? restIssue({ number: index + 1, html_url: `${BASE}/pull/${index + 1}`, pull_request: {} })
        : restIssue({ number: index + 1 }));
    routeGh(() => JSON.stringify(page));
    const result = await listAssignedIssues(REPO, "octobot", 1);
    expect(result.issues).toHaveLength(47);
    expect(result.hasMore).toBe(true);
    expect(calls()).toHaveLength(1);
  });

  it("rejects invalid pages and viewers before calling gh", async () => {
    await expect(listAssignedIssues(REPO, "octobot", 0)).rejects.toThrow(/page must be a positive integer/);
    await expect(listAssignedIssues(REPO, "octobot", 1.5)).rejects.toThrow(/page must be a positive integer/);
    await expect(listAssignedIssues(REPO, "bad login", 1)).rejects.toThrow(/invalid GitHub viewer login/);
    expect(mockedRunGh).not.toHaveBeenCalled();
  });

  it("rejects malformed issue data", async () => {
    routeGh(() => JSON.stringify([restIssue({ number: "7" })]));
    await expect(listAssignedIssues(REPO, "octobot", 1)).rejects.toThrow(/invalid assigned-issue data/);
  });

  it("wraps gh failures", async () => {
    mockedRunGh.mockRejectedValue(new Error("gh failed: rate limited"));
    await expect(listAssignedIssues(REPO, "octobot", 1))
      .rejects.toThrow(/could not list assigned issues in acme\/widgets.*rate limited/s);
  });
});

describe("readGithubIssue", () => {
  beforeEach(() => {
    mockedRunGh.mockReset();
  });

  it("reads the full issue and its comments from github.com", async () => {
    routeGh((call) => {
      if (call.route === `repos/${REPO}/issues/7`) {
        expect(call.paginate).toBe(false);
        return JSON.stringify(restIssue());
      }
      expect(call.route).toBe(`repos/${REPO}/issues/7/comments`);
      expect(call.paginate).toBe(true);
      expect(call.query.get("per_page")).toBe("100");
      return JSON.stringify([[restComment()]]);
    });
    const issue = await readGithubIssue(`${BASE}/issues/7`);
    expect(issue).toEqual({
      url: `${BASE}/issues/7`,
      number: 7,
      title: "Fix the login flow",
      state: "open",
      body: "Steps to reproduce",
      labels: ["bug"],
      assignees: ["octobot"],
      updatedAt: "2026-09-01T10:00:00Z",
      comments: [{
        author: "monalisa",
        body: "A comment",
        url: `${BASE}/issues/7#issuecomment-1`,
        createdAt: "2026-09-02T10:00:00Z",
      }],
    });
    expect(calls()).toHaveLength(2);
    expect(calls()[0]!.args).toContain("github.com");
  });

  it("supports empty bodies, missing labels, absent assignees, and deleted comment authors", async () => {
    routeGh((call) => JSON.stringify(
      call.route.endsWith("/comments")
        ? [[restComment({ user: null, body: "" })]]
        : restIssue({ body: null, labels: [], assignees: null }),
    ));
    const issue = await readGithubIssue(`${BASE}/issues/7`);
    expect(issue.body).toBe("");
    expect(issue.labels).toEqual([]);
    expect(issue.assignees).toEqual([]);
    expect(issue.comments).toEqual([{
      author: "ghost",
      body: "",
      url: `${BASE}/issues/7#issuecomment-1`,
      createdAt: "2026-09-02T10:00:00Z",
    }]);
  });

  it("flattens every comment page", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      restComment({ html_url: `${BASE}/issues/7#issuecomment-${index + 1}` }));
    routeGh((call) => JSON.stringify(
      call.route.endsWith("/comments") ? [first, [restComment({ user: null })]] : restIssue(),
    ));
    const issue = await readGithubIssue(`${BASE}/issues/7`);
    expect(issue.comments).toHaveLength(101);
    expect(issue.comments[0]).toMatchObject({ author: "monalisa" });
    expect(issue.comments[100]).toMatchObject({ author: "ghost" });
  });

  it("fails loudly instead of truncating an oversized comment section", async () => {
    const page = Array.from({ length: 100 }, () => restComment());
    routeGh((call) => JSON.stringify(
      call.route.endsWith("/comments")
        ? Array.from({ length: 11 }, () => page)
        : restIssue(),
    ));
    await expect(readGithubIssue(`${BASE}/issues/7`)).rejects.toThrow(/more than 1000 comments/);
  });

  it("rejects pull request URLs and pull request records", async () => {
    await expect(readGithubIssue(`${BASE}/pull/7`)).rejects.toThrow(/expected a github\.com issue URL/);
    expect(mockedRunGh).not.toHaveBeenCalled();

    routeGh(() => JSON.stringify(restIssue({ pull_request: {} })));
    await expect(readGithubIssue(`${BASE}/issues/7`)).rejects.toThrow(/is a pull request, not an issue/);
  });

  it("rejects URLs with queries", async () => {
    await expect(readGithubIssue(`${BASE}/issues/7?foo=bar`))
      .rejects.toThrow(/expected a github\.com issue URL/);
    expect(mockedRunGh).not.toHaveBeenCalled();
  });

  it("validates that the returned issue matches the request", async () => {
    routeGh((call) => JSON.stringify(
      call.route.endsWith("/comments") ? [[]] : restIssue({ number: 8, html_url: `${BASE}/issues/8` }),
    ));
    await expect(readGithubIssue(`${BASE}/issues/7`)).rejects.toThrow(/different issue/);

    mockedRunGh.mockReset();
    routeGh((call) => JSON.stringify(
      call.route.endsWith("/comments")
        ? [[]]
        : restIssue({ html_url: "https://github.com/other/repo/issues/7" }),
    ));
    await expect(readGithubIssue(`${BASE}/issues/7`)).rejects.toThrow(/different issue/);
  });

  it("wraps gh failures", async () => {
    mockedRunGh.mockRejectedValue(new Error("gh failed: not found"));
    await expect(readGithubIssue(`${BASE}/issues/7`))
      .rejects.toThrow(/could not read https:\/\/github\.com\/acme\/widgets\/issues\/7.*not found/s);
  });
});

describe("readIssue", () => {
  beforeEach(() => {
    mockedRunGh.mockReset();
  });

  it("reads title, body, and label names", async () => {
    mockedRunGh.mockResolvedValue(JSON.stringify({
      title: "T", body: "B", labels: [{ name: "a" }, { name: 5 }, {}],
    }));
    await expect(readIssue(`${BASE}/issues/7`)).resolves.toEqual({ title: "T", body: "B", labels: ["a"] });
  });

  it("rejects invalid data and gh failures", async () => {
    mockedRunGh.mockResolvedValue(JSON.stringify({ title: "T" }));
    await expect(readIssue(`${BASE}/issues/7`)).rejects.toThrow(/could not read/);
    mockedRunGh.mockResolvedValue("not json");
    await expect(readIssue(`${BASE}/issues/7`)).rejects.toThrow(/could not read/);
    mockedRunGh.mockRejectedValue(new Error("gh failed: boom"));
    await expect(readIssue(`${BASE}/issues/7`)).rejects.toThrow(/could not read.*boom/s);
  });
});
