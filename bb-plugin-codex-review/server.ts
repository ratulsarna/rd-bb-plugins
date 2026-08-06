import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
} from "@bb/plugin-sdk";
import { z } from "zod";

const REVIEW_TITLE = "Codex Review";
const METADATA_TITLE = "Codex Review metadata";
const RESULT_MAX_BYTES = 200_000;
const RESULT_STORAGE_MAX_BYTES = 240_000;
const RECENT_COMMIT_LIMIT = 20;
const runningStatuses = new Set(["starting", "running"]);
const outputKey = (terminalId: string) => `review-output:${terminalId}`;
const resultKey = (terminalId: string) => `review-result:${terminalId}`;
const requestKey = (terminalId: string) => `review-request:${terminalId}`;
const latestKey = (threadId: string) => `review-latest:${threadId}`;
const runKey = (threadId: string, runId: string) => `review-run:${threadId}:${runId}`;

type ReviewOutput = {
  hostId: string;
  path: string;
  threadId: string;
};

type ReviewRun = { terminalId: string };
type ReviewResult = { output: string; threadId?: string };
type ReviewState = {
  status: "starting" | "running" | "exited" | "disconnected";
  exitCode: number | null;
  output: string;
};

const reviewStatus = z.enum(["starting", "running", "exited", "disconnected"]);
const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  z
    .object({ kind: z.literal("base"), branch: z.string().trim().min(1).max(255) })
    .strict(),
  z
    .object({
      kind: z.literal("commit"),
      sha: z
        .string()
        .trim()
        .regex(/^[0-9a-fA-F]{4,64}$/, "Enter a commit SHA."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      instructions: z.string().trim().min(1).max(20_000),
    })
    .strict(),
]);

const branchOptionSchema = z
  .object({
    name: z.string(),
    kind: z.enum(["local", "remote"]),
  })
  .strict();
const commitOptionSchema = z
  .object({
    sha: z.string(),
    shortSha: z.string(),
    subject: z.string(),
    committedAt: z.string(),
  })
  .strict();

export type ReviewTarget = z.infer<typeof reviewTargetSchema>;

export const rpcContract = defineRpcContract({
  searchBranches: {
    input: z
      .object({ threadId: z.string().min(1), query: z.string().max(256) })
      .strict(),
    output: z.object({ branches: z.array(branchOptionSchema) }).strict(),
  },
  listRecentCommits: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ commits: z.array(commitOptionSchema) }).strict(),
  },
  startReview: {
    input: z
      .object({
        threadId: z.string().min(1),
        runId: z.string().min(1),
        target: reviewTargetSchema,
      })
      .strict(),
    output: z.object({ terminalId: z.string() }).strict(),
  },
  getReview: {
    input: z
      .object({ threadId: z.string().min(1), terminalId: z.string().min(1) })
      .strict(),
    output: z
      .object({
        status: reviewStatus,
        exitCode: z.number().int().nullable(),
        output: z.string(),
      })
      .strict(),
  },
  getLatestReview: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ terminalId: z.string().nullable() }).strict(),
  },
  stopReview: {
    input: z
      .object({ threadId: z.string().min(1), terminalId: z.string().min(1) })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export default function plugin(bb: BbPluginApi) {
  const starts = new Map<
    string,
    { target: ReviewTarget; promise: Promise<{ terminalId: string }> }
  >();

  async function startReview(
    threadId: string,
    target: ReviewTarget,
    runId: string,
  ) {
    const previous = await bb.storage.kv.get<ReviewRun>(runKey(threadId, runId));
    if (previous) return previous;

    let pending = starts.get(threadId);
    if (pending && !sameTarget(pending.target, target)) {
      throw new Error("A different Codex review is already starting in this thread.");
    }
    if (!pending) {
      pending = { target, promise: createReview(bb, threadId, target) };
      starts.set(threadId, pending);
    }
    try {
      const review = await pending.promise;
      await bb.storage.kv.set(latestKey(threadId), review);
      await bb.storage.kv.set(runKey(threadId, runId), review);
      return review;
    } finally {
      if (starts.get(threadId) === pending) starts.delete(threadId);
    }
  }

  async function getReview(threadId: string, terminalId: string): Promise<ReviewState> {
    let terminal = await bb.sdk.terminals.get({ terminalId });
    assertThreadTerminal(terminal.threadId, threadId);
    const cached = await bb.storage.kv.get<ReviewResult>(resultKey(terminalId));
    const record = await bb.storage.kv.get<ReviewOutput>(outputKey(terminalId));

    if (runningStatuses.has(terminal.status)) {
      if (!record || record.threadId !== threadId) {
        throw new Error("Review output is unavailable.");
      }
      try {
        const result = fitReviewResult(
          await readTerminalTail(bb, terminalId),
          threadId,
        );
        return {
          status: terminal.status,
          exitCode: terminal.exitCode,
          output: result.output,
        };
      } catch (error) {
        const refreshed = await bb.sdk.terminals.get({ terminalId });
        assertThreadTerminal(refreshed.threadId, threadId);
        if (runningStatuses.has(refreshed.status)) throw error;
        terminal = refreshed;
      }
    }
    const result = record?.threadId === threadId
      ? await persistResultOrFallback(bb, terminalId, record, cached)
      : cached;
    if (!result) throw new Error("Review output is unavailable.");

    return {
      status: terminal.status,
      exitCode: terminal.exitCode,
      output: result.output,
    };
  }

  async function stopReview(threadId: string, terminalId: string) {
    const terminal = await bb.sdk.terminals.get({ terminalId });
    assertThreadTerminal(terminal.threadId, threadId);
    const record = await bb.storage.kv.get<ReviewOutput>(outputKey(terminalId));
    if (runningStatuses.has(terminal.status)) {
      const result = fitReviewResult(
        await readTerminalTail(bb, terminalId),
        threadId,
      );
      await bb.storage.kv.set(resultKey(terminalId), result);
    } else if (record) {
      await persistResultAndRemoveFile(bb, terminalId, record);
    }
    await bb.sdk.terminals.close({ terminalId, mode: "force" });
    if (record && runningStatuses.has(terminal.status)) {
      await removeOutputFile(bb, terminalId, record);
    }
  }

  bb.rpc.register(rpcContract, {
    async searchBranches({ threadId, query }) {
      return { branches: await searchBranches(bb, threadId, query) };
    },

    async listRecentCommits({ threadId }) {
      return { commits: await listRecentCommits(bb, threadId) };
    },

    async startReview({ threadId, runId, target }) {
      return startReview(threadId, target, runId);
    },

    async getReview({ threadId, terminalId }) {
      return getReview(threadId, terminalId);
    },

    async getLatestReview({ threadId }) {
      const terminalId = await findLatestReview(bb, threadId);
      return { terminalId };
    },

    async stopReview({ threadId, terminalId }) {
      await stopReview(threadId, terminalId);
      return { ok: true as const };
    },
  });

  bb.cli.register({
    name: "codex-review",
    summary: "Run native Codex code reviews in the current bb thread",
    commands: [
      {
        name: "uncommitted",
        summary: "Review staged, unstaged, and untracked changes",
        usage: "bb codex-review uncommitted [--thread <threadId>]",
      },
      {
        name: "base",
        summary: "Review changes against a base branch",
        usage: "bb codex-review base <branch> [--thread <threadId>]",
      },
      {
        name: "commit",
        summary: "Review one commit",
        usage: "bb codex-review commit <sha> [--thread <threadId>]",
      },
      {
        name: "custom",
        summary: "Run a review using custom instructions",
        usage: "bb codex-review custom <instructions...> [--thread <threadId>]",
      },
    ],
    async run(argv, ctx) {
      if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
        return { exitCode: 0, stdout: `${cliUsage()}\n` };
      }
      const parsed = parseCliRequest(argv, ctx);
      if (!parsed.ok) {
        return { exitCode: 2, stderr: `${parsed.error}\n\n${cliUsage()}\n` };
      }
      try {
        const { terminalId } = await startReview(
          parsed.threadId,
          parsed.target,
          randomUUID(),
        );
        const review = await waitForReview(
          () => getReview(parsed.threadId, terminalId),
          ctx.signal,
        );
        return {
          exitCode: review.exitCode ?? 1,
          stdout: review.output,
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}

async function searchBranches(
  bb: BbPluginApi,
  threadId: string,
  rawQuery: string,
) {
  const environment = await getReviewEnvironment(bb, threadId);
  const query = rawQuery.trim();
  const found = await bb.sdk.environments.diffBranches({
    environmentId: environment.id,
    limit: "1000",
    ...(query ? { query } : {}),
  });
  if (!found.branchesTruncated && !found.remoteBranchesTruncated) {
    return dedupeBranches([
      ...found.branches.map((name) => ({ name, kind: "local" as const })),
      ...found.remoteBranches.map((name) => ({ name, kind: "remote" as const })),
    ]);
  }

  const capture = await runEnvironmentCommand(bb, environment.id, [
    "for-each-ref",
    "--format=%(refname)%09%(symref)",
    "refs/heads",
    "refs/remotes",
  ]);
  const loweredQuery = query.toLowerCase();
  return dedupeBranches(
    capture.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(([ref, symbolic]) => ref && !symbolic)
      .map(([ref]) => {
        if (ref.startsWith("refs/heads/")) {
          return { name: ref.slice("refs/heads/".length), kind: "local" as const };
        }
        return {
          name: ref.slice("refs/remotes/".length),
          kind: "remote" as const,
        };
      })
      .filter(({ name }) => name.toLowerCase().includes(loweredQuery)),
  );
}

async function listRecentCommits(bb: BbPluginApi, threadId: string) {
  const environment = await getReviewEnvironment(bb, threadId);
  const capture = await runEnvironmentCommand(bb, environment.id, [
    "log",
    "--all",
    "-n",
    String(RECENT_COMMIT_LIMIT),
    "--format=%H%x00%h%x00%cI%x00%s%x00",
  ]);
  const fields = capture.stdout.split("\0");
  const commits: Array<{
    sha: string;
    shortSha: string;
    subject: string;
    committedAt: string;
  }> = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const sha = fields[index]?.replace(/^\n+/u, "").trim();
    const shortSha = fields[index + 1]?.trim();
    const committedAt = fields[index + 2]?.trim();
    const subject = fields[index + 3]?.trim();
    if (sha && shortSha && committedAt && subject) {
      commits.push({ sha, shortSha, subject, committedAt });
    }
  }
  return commits;
}

function dedupeBranches(
  branches: Array<{ name: string; kind: "local" | "remote" }>,
) {
  return Array.from(
    new Map(branches.map((branch) => [`${branch.kind}:${branch.name}`, branch])).values(),
  ).sort((left, right) => left.name.localeCompare(right.name));
}

async function getReviewEnvironment(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({
    threadId,
    include: "environment",
  });
  const environment = "environment" in thread ? thread.environment : null;
  if (!environment?.isGitRepo || !environment.path) {
    throw new Error(
      "This thread is not attached to a Git repository. Open a thread in the project you want to review.",
    );
  }
  if (/^[A-Za-z]:[\\/]/.test(environment.path)) {
    throw new Error(
      "Codex Review is not supported on Windows hosts because bb terminals are currently POSIX-only.",
    );
  }
  return { ...environment, path: environment.path };
}

async function createReview(
  bb: BbPluginApi,
  threadId: string,
  target: ReviewTarget,
) {
  const environment = await getReviewEnvironment(bb, threadId);

  const { sessions } = await bb.sdk.terminals.list({
    scope: { kind: "thread", threadId },
  });
  const existing = sessions.find(
    (session) =>
      session.title === REVIEW_TITLE && runningStatuses.has(session.status),
  );
  if (existing) {
    const existingTarget = await bb.storage.kv.get<ReviewTarget>(
      requestKey(existing.id),
    );
    if (existingTarget && sameTarget(existingTarget, target)) {
      return { terminalId: existing.id };
    }
    throw new Error("A different Codex review is already running in this thread.");
  }

  await cleanupPreviousReviews(bb, threadId);
  const outputPath = `/tmp/bb-codex-review-${randomUUID()}.log`;
  const terminal = await bb.sdk.terminals.create({
    scope: { kind: "thread", threadId },
    cols: 120,
    rows: 30,
    title: REVIEW_TITLE,
    start: {
      mode: "command",
      command: reviewCommand(environment.path, outputPath, target),
    },
  });
  await bb.storage.kv.set(outputKey(terminal.id), {
    hostId: terminal.hostId,
    path: outputPath,
    threadId,
  });
  await bb.storage.kv.set(requestKey(terminal.id), target);
  return { terminalId: terminal.id };
}

function sameTarget(left: ReviewTarget, right: ReviewTarget) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function cleanupPreviousReviews(bb: BbPluginApi, threadId: string) {
  const latest = await bb.storage.kv.get<ReviewRun>(latestKey(threadId));
  const keys = await bb.storage.kv.list("review-output:");
  await Promise.all(
    keys.map(async (key) => {
      const record = await bb.storage.kv.get<ReviewOutput>(key);
      if (!record || record.threadId !== threadId) return;
      const terminalId = key.slice("review-output:".length);
      await removeOutputFile(bb, terminalId, record);
    }),
  );

  const resultKeys = await bb.storage.kv.list("review-result:");
  await Promise.all(
    resultKeys.map(async (key) => {
      const result = await bb.storage.kv.get<ReviewResult>(key);
      const isLatest = latest && key === resultKey(latest.terminalId);
      if (isLatest || result?.threadId === threadId) {
        await bb.storage.kv.delete(key);
      }
    }),
  );
  await Promise.all(
    (await bb.storage.kv.list(`review-run:${threadId}:`)).map((key) =>
      bb.storage.kv.delete(key),
    ),
  );
  await Promise.all(
    (await bb.storage.kv.list("review-request:")).map(async (key) => {
      const terminalId = key.slice("review-request:".length);
      try {
        const terminal = await bb.sdk.terminals.get({ terminalId });
        if (terminal.threadId === threadId) await bb.storage.kv.delete(key);
      } catch {
        await bb.storage.kv.delete(key);
      }
    }),
  );
  await bb.storage.kv.delete(latestKey(threadId));
}

async function persistResultAndRemoveFile(
  bb: BbPluginApi,
  terminalId: string,
  record: ReviewOutput,
) {
  const file = await bb.sdk.files.read({
    hostId: record.hostId,
    path: record.path,
  });
  const output = normalizeOutput(
    file.contentEncoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content,
  );
  const result = fitReviewResult(output, record.threadId);
  await bb.storage.kv.set(resultKey(terminalId), result);
  await removeOutputFile(bb, terminalId, record);
  return result;
}

async function persistResultOrFallback(
  bb: BbPluginApi,
  terminalId: string,
  record: ReviewOutput,
  cached: ReviewResult | undefined,
) {
  try {
    return await persistResultAndRemoveFile(bb, terminalId, record);
  } catch (error) {
    let result = cached;
    if (!result) {
      try {
        result = fitReviewResult(
          await readTerminalTail(bb, terminalId),
          record.threadId,
        );
      } catch {
        throw error;
      }
    }
    await bb.storage.kv.set(resultKey(terminalId), result);
    await removeOutputFile(bb, terminalId, record);
    return result;
  }
}

async function findLatestReview(bb: BbPluginApi, threadId: string) {
  const latest = await bb.storage.kv.get<ReviewRun>(latestKey(threadId));
  if (latest) {
    try {
      const terminal = await bb.sdk.terminals.get({ terminalId: latest.terminalId });
      assertThreadTerminal(terminal.threadId, threadId);
      return latest.terminalId;
    } catch {
      await bb.storage.kv.delete(latestKey(threadId));
    }
  }

  const { sessions } = await bb.sdk.terminals.list({
    scope: { kind: "thread", threadId },
  });
  const candidates = sessions
    .filter((session) => session.title === REVIEW_TITLE)
    .sort((left, right) => right.createdAt - left.createdAt);
  for (const session of candidates) {
    const record = await bb.storage.kv.get<ReviewOutput>(outputKey(session.id));
    const result = await bb.storage.kv.get<ReviewResult>(resultKey(session.id));
    if (runningStatuses.has(session.status) || record?.threadId === threadId || result) {
      await bb.storage.kv.set(latestKey(threadId), { terminalId: session.id });
      return session.id;
    }
  }
  return null;
}

async function removeOutputFile(
  bb: BbPluginApi,
  terminalId: string,
  record: ReviewOutput,
) {
  try {
    await bb.sdk.files.remove({
      hostId: record.hostId,
      path: record.path,
    });
  } catch (error) {
    bb.log.warn(
      `Could not remove cached review output for ${terminalId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await bb.storage.kv.delete(outputKey(terminalId));
  }
}

async function readTerminalTail(bb: BbPluginApi, terminalId: string) {
  const { chunks } = await bb.sdk.terminals.output({
    terminalId,
    tailBytes: RESULT_MAX_BYTES,
  });
  return normalizeOutput(
    chunks
      .map(({ dataBase64 }) =>
        Buffer.from(dataBase64, "base64").toString("utf8"),
      )
      .join(""),
  );
}

async function runEnvironmentCommand(
  bb: BbPluginApi,
  environmentId: string,
  args: string[],
) {
  const outputPath = `/tmp/bb-codex-review-metadata-${randomUUID()}.json`;
  const terminal = await bb.sdk.terminals.create({
    scope: { kind: "environment", environmentId },
    cols: 120,
    rows: 20,
    title: METADATA_TITLE,
    start: {
      mode: "command",
      command: captureCommand(outputPath, "git", args),
    },
  });
  try {
    while (true) {
      const current = await bb.sdk.terminals.get({ terminalId: terminal.id });
      if (!runningStatuses.has(current.status)) break;
      await delay(100);
    }
    const file = await bb.sdk.files.read({
      hostId: terminal.hostId,
      path: outputPath,
    });
    const content = file.contentEncoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content;
    const capture = JSON.parse(content) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    if (capture.exitCode !== 0) {
      throw new Error(capture.stderr.trim() || `git exited with ${capture.exitCode}`);
    }
    return capture;
  } finally {
    try {
      await bb.sdk.files.remove({
        hostId: terminal.hostId,
        path: outputPath,
      });
    } catch {
      // The collector may have failed before creating its output file.
    }
  }
}

function captureCommand(outputPath: string, command: string, args: string[]) {
  const commandBase64 = Buffer.from(command).toString("base64");
  const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");
  const collector = [
    'const fs=require("node:fs");',
    'const {spawn}=require("node:child_process");',
    `const command=Buffer.from("${commandBase64}","base64").toString();`,
    `const args=JSON.parse(Buffer.from("${argsBase64}","base64").toString());`,
    'const child=spawn(command,args,{cwd:process.cwd()});',
    'let stdout="",stderr="",finished=false;',
    'child.stdout.on("data",chunk=>{stdout+=chunk.toString();});',
    'child.stderr.on("data",chunk=>{stderr+=chunk.toString();});',
    'const finish=exitCode=>{if(finished)return;finished=true;',
    `fs.writeFileSync("${outputPath}",JSON.stringify({exitCode,stdout,stderr}),{mode:0o600});`,
    'process.exitCode=exitCode;};',
    'child.on("error",error=>{stderr+=`${error.message}\\n`;finish(1);});',
    'child.on("close",code=>finish(code??1));',
  ].join("");
  return `node -e ${shellQuote(collector)}`;
}

function parseCliRequest(
  argv: string[],
  ctx: PluginCliContext,
):
  | { ok: true; threadId: string; target: ReviewTarget }
  | { ok: false; error: string } {
  const args = [...argv];
  let threadId = ctx.threadId;
  if (args[0] === "--thread") {
    threadId = args[1];
    args.splice(0, 2);
  } else if (args.at(-2) === "--thread") {
    threadId = args.at(-1);
    args.splice(-2, 2);
  }
  if (!threadId) {
    return {
      ok: false,
      error: "No bb thread context. Run from a thread or pass --thread <threadId>.",
    };
  }

  const command = args.shift() ?? "uncommitted";
  if (command === "uncommitted" && args.length === 0) {
    return { ok: true, threadId, target: { kind: "uncommitted" } };
  }
  if (command === "base" && args.length === 1) {
    return { ok: true, threadId, target: { kind: "base", branch: args[0]! } };
  }
  if (command === "commit" && args.length === 1) {
    const parsed = reviewTargetSchema.safeParse({ kind: "commit", sha: args[0] });
    if (!parsed.success) return { ok: false, error: "Enter a valid commit SHA." };
    return { ok: true, threadId, target: parsed.data };
  }
  if (command === "custom" && args.length > 0) {
    const parsed = reviewTargetSchema.safeParse({
      kind: "custom",
      instructions: args.join(" "),
    });
    if (!parsed.success) {
      return { ok: false, error: "Custom review instructions are required." };
    }
    return { ok: true, threadId, target: parsed.data };
  }
  return { ok: false, error: `Invalid codex-review command: ${command}` };
}

function cliUsage() {
  return [
    "Usage:",
    "  bb codex-review uncommitted [--thread <threadId>]",
    "  bb codex-review base <branch> [--thread <threadId>]",
    "  bb codex-review commit <sha> [--thread <threadId>]",
    "  bb codex-review custom <instructions...> [--thread <threadId>]",
  ].join("\n");
}

async function waitForReview(
  load: () => Promise<ReviewState>,
  signal?: AbortSignal,
) {
  while (true) {
    if (signal?.aborted) {
      throw new Error("CLI disconnected; the review is still running in bb.");
    }
    const review = await load();
    if (!runningStatuses.has(review.status)) return review;
    await delay(1_000, signal);
  }
}

function delay(durationMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted."));
      return;
    }
    const timer = setTimeout(done, durationMs);
    signal?.addEventListener("abort", aborted, { once: true });
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(new Error("Operation aborted."));
    }
  });
}

function reviewCommand(
  workspacePath: string,
  outputPath: string,
  target: ReviewTarget,
) {
  const workspaceBase64 = Buffer.from(workspacePath).toString("base64");
  const argsBase64 = Buffer.from(
    JSON.stringify([
      "exec",
      "--output-last-message",
      outputPath,
      ...reviewArgs(target),
    ]),
  ).toString("base64");
  const collector = [
    'const fs=require("node:fs");',
    'const {spawn}=require("node:child_process");',
    `const limit=${RESULT_MAX_BYTES};`,
    "let chunks=[],size=0;",
    "let finished=false;",
    'const collect=chunk=>{',
    "process.stdout.write(chunk);chunks.push(chunk);size+=chunk.length;",
    "while(size>limit){const excess=size-limit;",
    "if(chunks[0].length<=excess){size-=chunks.shift().length;}",
    "else{chunks[0]=chunks[0].subarray(excess);size-=excess;}}};",
    `const cwd=Buffer.from("${workspaceBase64}","base64").toString();`,
    `const args=JSON.parse(Buffer.from("${argsBase64}","base64").toString());`,
    'const child=spawn("codex",args,{cwd});',
    'child.stdout.on("data",collect);child.stderr.on("data",collect);',
    'const finish=code=>{if(finished)return;finished=true;',
    `if(!fs.existsSync("${outputPath}")||fs.statSync("${outputPath}").size===0)`,
    `fs.writeFileSync("${outputPath}",Buffer.concat(chunks),{mode:0o600});`,
    "process.exitCode=code;};",
    'child.on("error",error=>{collect(Buffer.from(`${error.message}\\n`));finish(1);});',
    'child.on("close",code=>finish(code??1));',
  ].join("");
  return `node -e ${shellQuote(collector)}`;
}

function reviewArgs(target: ReviewTarget) {
  const args = ["review"];
  if (target.kind === "uncommitted") args.push("--uncommitted");
  if (target.kind === "base") args.push("--base", target.branch);
  if (target.kind === "commit") args.push("--commit", target.sha);
  if (target.kind === "custom") args.push(target.instructions);
  return args;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizeOutput(output: string) {
  const tail = Buffer.from(output).subarray(-RESULT_MAX_BYTES).toString("utf8");
  return stripVTControlCharacters(tail)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function fitReviewResult(output: string, threadId: string): ReviewResult {
  const bytes = Buffer.from(output);
  let low = 0;
  let high = bytes.length;
  let best = "";
  while (low <= high) {
    const start = Math.floor((low + high) / 2);
    const candidate = bytes.subarray(start).toString("utf8");
    const serializedBytes = Buffer.byteLength(
      JSON.stringify({ output: candidate, threadId }),
    );
    if (serializedBytes <= RESULT_STORAGE_MAX_BYTES) {
      best = candidate;
      high = start - 1;
    } else {
      low = start + 1;
    }
  }
  return { output: best, threadId };
}

function assertThreadTerminal(
  actualThreadId: string | null,
  expectedThreadId: string,
) {
  if (actualThreadId !== expectedThreadId) {
    throw new Error("Review terminal does not belong to this thread.");
  }
}
