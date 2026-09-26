import { z } from "zod";
import { runGh } from "./gh";
import {
  githubIssueCommentSchema, githubIssueDetailsSchema, githubIssueSummarySchema,
  type GithubIssueComment, type GithubIssueDetails, type GithubIssueSummary,
} from "./issue-types";

export interface IssueDetails {
  title: string;
  body: string;
  labels: string[];
}

const ISSUES_PER_PAGE = 50;
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENTS = 1000;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function text(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 2_000);
}

function excerpt(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

function parseJson(stdout: string, description: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`gh returned invalid JSON for ${description}`);
  }
}

function objects(value: unknown, description: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`GitHub returned invalid ${description}`);
  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`GitHub returned invalid ${description}`);
    }
    return item as Record<string, unknown>;
  });
}

function fieldNames(value: unknown, key: "name" | "login", description: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`GitHub returned invalid ${description}`);
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const name = (entry as Record<string, unknown>)[key];
    return typeof name === "string" ? [name] : [];
  });
}

function repositoryFromPath(path: string): string {
  const match = path.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new Error("could not read owner/repo from the project's git remote");
  }
  return `${match[1]}/${match[2]}`;
}

export function githubRepository(remote: string | null): string {
  const value = typeof remote === "string" ? remote.trim() : "";
  if (!value) throw new Error("the project has no git remote URL");
  const unsupported = new Error(
    "git remote must point at github.com over HTTPS or SSH",
  );

  if (value.includes("://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw unsupported;
    }
    const https = url.protocol === "https:" && url.port === "";
    const ssh = url.protocol === "ssh:" && (url.port === "" || url.port === "22");
    if (url.hostname.toLowerCase() !== "github.com" || url.password || url.search || url.hash || !(https || ssh)) throw unsupported;
    return repositoryFromPath(url.pathname);
  }

  const scp = value.match(/^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (scp) {
    if (scp[1].toLowerCase() !== "github.com") throw unsupported;
    return repositoryFromPath(`/${scp[2]}/${scp[3]}`);
  }

  throw unsupported;
}

export function normalizeGithubIssueUrl(value: string): string | null {
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
    url.password !== "" ||
    url.search !== ""
  ) {
    return null;
  }

  const match = url.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\/?$/,
  );
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    return null;
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  return `https://github.com/${match[1]}/${match[2]}/issues/${number}`;
}

export async function readGithubViewer(): Promise<string> {
  try {
    const raw = parseJson(await runGh(["api", "--hostname", "github.com", "user"]), "the GitHub user");
    if (typeof raw !== "object" || raw === null) throw new Error("gh returned an invalid GitHub user");
    const login = (raw as Record<string, unknown>).login;
    if (typeof login !== "string" || !LOGIN_PATTERN.test(login)) {
      throw new Error("gh returned an invalid GitHub login");
    }
    return login;
  } catch (cause) {
    throw new Error(`could not read the GitHub account: ${text(cause)}`);
  }
}

function issuesPath(repository: string, viewer: string, page: number, perPage: number): string {
  const query = new URLSearchParams({
    state: "open",
    sort: "updated",
    direction: "desc",
    assignee: viewer,
    per_page: String(perPage),
    page: String(page),
  });
  return `repos/${repository}/issues?${query.toString()}`;
}

function parseAssignedIssue(item: Record<string, unknown>): GithubIssueSummary {
  const candidate = {
    url: item.html_url,
    number: item.number,
    title: item.title,
    state: item.state,
    labels: fieldNames(item.labels, "name", "assigned-issue labels"),
    assignees: fieldNames(item.assignees, "login", "assigned-issue assignees"),
    updatedAt: item.updated_at,
  };
  const result = githubIssueSummarySchema.safeParse(candidate);
  if (!result.success) throw new Error("GitHub returned invalid assigned-issue data");
  return result.data;
}

export async function listAssignedIssues(
  repository: string,
  viewer: string,
  page: number,
): Promise<{ issues: GithubIssueSummary[]; hasMore: boolean }> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("page must be a positive integer");
  if (!LOGIN_PATTERN.test(viewer)) {
    throw new Error(`invalid GitHub viewer login: ${excerpt(viewer)}`);
  }
  try {
    const raw = parseJson(
      await runGh(["api", "--hostname", "github.com", issuesPath(repository, viewer, page, ISSUES_PER_PAGE)]),
      "assigned issues",
    );
    // REST issue listings also contain pull requests; drop them by their marker field.
    const rawItems = objects(raw, "assigned issues");
    const issues = rawItems
      .filter((item) => item.pull_request === undefined)
      .map(parseAssignedIssue);
    // A full raw page may still be the last one; browsing then shows one empty page.
    const hasMore = rawItems.length === ISSUES_PER_PAGE;
    return { issues, hasMore };
  } catch (cause) {
    throw new Error(`could not list assigned issues in ${repository}: ${text(cause)}`);
  }
}

function commentItems(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) throw new Error("GitHub returned invalid issue comments");
  const items: unknown[] = [];
  for (const page of raw) {
    if (!Array.isArray(page)) throw new Error("GitHub returned invalid issue comments");
    items.push(...page);
  }
  return objects(items, "issue comments");
}

function parseComment(item: Record<string, unknown>): GithubIssueComment {
  const user = item.user;
  const login = typeof user === "object" && user !== null
    ? (user as Record<string, unknown>).login
    : undefined;
  const result = githubIssueCommentSchema.safeParse({
    author: typeof login === "string" && login !== "" ? login : "ghost",
    body: item.body,
    url: item.html_url,
    createdAt: item.created_at,
  });
  if (!result.success) throw new Error("GitHub returned an invalid issue comment");
  return result.data;
}

export async function readGithubIssue(url: string): Promise<GithubIssueDetails> {
  const normalized = normalizeGithubIssueUrl(url);
  if (normalized === null) {
    throw new Error(`expected a github.com issue URL: ${excerpt(url)}`);
  }
  const [, owner, repo, , numberText] = new URL(normalized).pathname.split("/");
  try {
    const raw = parseJson(
      await runGh(["api", "--hostname", "github.com", `repos/${owner}/${repo}/issues/${numberText}`]),
      "the issue",
    );
    if (typeof raw !== "object" || raw === null) throw new Error("gh returned an invalid issue");
    const issue = raw as Record<string, unknown>;
    if (issue.pull_request !== undefined) {
      throw new Error(`${normalized} is a pull request, not an issue`);
    }
    if (issue.number !== Number(numberText)) {
      throw new Error("GitHub returned a different issue than requested");
    }
    if (
      typeof issue.html_url !== "string" ||
      normalizeGithubIssueUrl(issue.html_url)?.toLowerCase() !== normalized.toLowerCase()
    ) {
      throw new Error("GitHub returned a different issue than requested");
    }

    const rawComments = parseJson(
      await runGh([
        "api", "--hostname", "github.com", "--paginate", "--slurp",
        `repos/${owner}/${repo}/issues/${numberText}/comments?per_page=${COMMENTS_PER_PAGE}`,
      ]),
      "the issue comments",
    );
    const comments = commentItems(rawComments).map(parseComment);
    if (comments.length > MAX_COMMENTS) {
      throw new Error(`the issue has more than ${MAX_COMMENTS} comments`);
    }

    const result = githubIssueDetailsSchema.safeParse({
      url: normalized,
      number: Number(numberText),
      title: issue.title,
      state: issue.state,
      body: issue.body ?? "",
      labels: fieldNames(issue.labels, "name", "issue labels"),
      assignees: fieldNames(issue.assignees, "login", "issue assignees"),
      updatedAt: issue.updated_at,
      comments,
    });
    if (!result.success) throw new Error("gh returned an invalid issue");
    return result.data;
  } catch (cause) {
    throw new Error(`could not read ${normalized}: ${text(cause)}`);
  }
}

export async function readIssue(url: string): Promise<IssueDetails> {
  try {
    const stdout = await runGh(["issue", "view", url, "--json", "title,body,labels"]);
    const value = JSON.parse(stdout) as {
      title?: unknown;
      body?: unknown;
      labels?: Array<{ name?: unknown }>;
    };
    if (
      typeof value.title !== "string" ||
      typeof value.body !== "string" ||
      !Array.isArray(value.labels)
    ) {
      throw new Error("gh returned an invalid issue");
    }
    return {
      title: value.title,
      body: value.body,
      labels: value.labels.flatMap((label) =>
        typeof label.name === "string" ? [label.name] : [],
      ),
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not read ${url}: ${message}`);
  }
}
