import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const REVIEW_TITLE = "Codex Review";
const RESULT_MAX_BYTES = 200_000;
const runningStatuses = new Set(["starting", "running"]);
const outputKey = (terminalId: string) => `review-output:${terminalId}`;
const resultKey = (terminalId: string) => `review-result:${terminalId}`;
const latestKey = (threadId: string) => `review-latest:${threadId}`;
const runKey = (threadId: string, runId: string) => `review-run:${threadId}:${runId}`;

type ReviewOutput = {
  hostId: string;
  path: string;
  threadId: string;
};

type ReviewRun = { terminalId: string };
type ReviewResult = { output: string; threadId?: string };

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
]);

export type ReviewTarget = z.infer<typeof reviewTargetSchema>;

export const rpcContract = defineRpcContract({
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
  const starts = new Map<string, Promise<{ terminalId: string }>>();

  bb.rpc.register(rpcContract, {
    async startReview({ threadId, runId, target }) {
      const previous = await bb.storage.kv.get<ReviewRun>(runKey(threadId, runId));
      if (previous) return previous;

      let start = starts.get(threadId);
      if (!start) {
        start = createReview(bb, threadId, target);
        starts.set(threadId, start);
      }
      try {
        const review = await start;
        await bb.storage.kv.set(latestKey(threadId), review);
        await bb.storage.kv.set(runKey(threadId, runId), review);
        return review;
      } finally {
        if (starts.get(threadId) === start) starts.delete(threadId);
      }
    },

    async getReview({ threadId, terminalId }) {
      let terminal = await bb.sdk.terminals.get({ terminalId });
      assertThreadTerminal(terminal.threadId, threadId);
      const cached = await bb.storage.kv.get<ReviewResult>(resultKey(terminalId));
      if (cached && !runningStatuses.has(terminal.status)) {
        return {
          status: terminal.status,
          exitCode: terminal.exitCode,
          output: cached.output,
        };
      }
      const record = await bb.storage.kv.get<ReviewOutput>(outputKey(terminalId));
      if (!record || record.threadId !== threadId) {
        throw new Error("Review output is unavailable.");
      }

      if (runningStatuses.has(terminal.status)) {
        try {
          const result = {
            output: await readTerminalTail(bb, terminalId),
            threadId,
          };
          await bb.storage.kv.set(resultKey(terminalId), result);
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
      const result = await persistResultOrFallback(
        bb,
        terminalId,
        record,
        cached,
      );

      return {
        status: terminal.status,
        exitCode: terminal.exitCode,
        output: result.output,
      };
    },

    async getLatestReview({ threadId }) {
      const terminalId = await findLatestReview(bb, threadId);
      return { terminalId };
    },

    async stopReview({ threadId, terminalId }) {
      const terminal = await bb.sdk.terminals.get({ terminalId });
      assertThreadTerminal(terminal.threadId, threadId);
      const record = await bb.storage.kv.get<ReviewOutput>(outputKey(terminalId));
      if (runningStatuses.has(terminal.status)) {
        const result = { output: await readTerminalTail(bb, terminalId), threadId };
        await bb.storage.kv.set(resultKey(terminalId), result);
      } else if (record) {
        await persistResultAndRemoveFile(bb, terminalId, record);
      }
      await bb.sdk.terminals.close({ terminalId, mode: "force" });
      if (record && runningStatuses.has(terminal.status)) {
        await removeOutputFile(bb, terminalId, record);
      }
      return { ok: true as const };
    },
  });
}

async function createReview(
  bb: BbPluginApi,
  threadId: string,
  target: ReviewTarget,
) {
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
  if (environment?.path && /^[A-Za-z]:[\\/]/.test(environment.path)) {
    throw new Error(
      "Codex Review is not supported on Windows hosts because bb terminals are currently POSIX-only.",
    );
  }

  const { sessions } = await bb.sdk.terminals.list({
    scope: { kind: "thread", threadId },
  });
  const existing = sessions.find(
    (session) =>
      session.title === REVIEW_TITLE && runningStatuses.has(session.status),
  );
  if (existing) return { terminalId: existing.id };

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
  return { terminalId: terminal.id };
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
  const result = { output, threadId: record.threadId };
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
        result = {
          output: await readTerminalTail(bb, terminalId),
          threadId: record.threadId,
        };
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

function reviewCommand(
  workspacePath: string,
  outputPath: string,
  target: ReviewTarget,
) {
  const workspaceBase64 = Buffer.from(workspacePath).toString("base64");
  const argsBase64 = Buffer.from(
    JSON.stringify(reviewArgs(target)),
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

function assertThreadTerminal(
  actualThreadId: string | null,
  expectedThreadId: string,
) {
  if (actualThreadId !== expectedThreadId) {
    throw new Error("Review terminal does not belong to this thread.");
  }
}
