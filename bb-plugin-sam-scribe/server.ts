// bb-plugin-sam-scribe: when a Sam thread has been quiet for a while, run the
// scribe over its new turns so Ratul's daily note keeps up with the day.
//
// The scribe itself is observe.py in Sam's memory folder. It reads the thread
// log from its own cursor and has pi bring the day's note up to date with the
// loaded local model. This plugin only decides when to call it: a quiet window
// after each idle, one thread at a time, plus an hourly sweep for anything an
// idle event missed. The script prints counts only, so its output is safe to
// log.
import { spawn } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { ScribeRunner } from "./runner.ts";

/** Keep only the end of a child's output; stack traces and bb errors are short anyway. */
const OUTPUT_TAIL_CHARS = 4_000;
/** observe.py exits 2 when no local model is loaded: a deferral, not a failure. */
const EXIT_NO_MODEL = 2;

interface ThreadLike {
  id: string;
  title: string | null;
  parentThreadId: string | null;
  environmentId: string | null;
  visibility: "visible" | "hidden";
  activeBackgroundAgentCount: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    samEnvPath: {
      type: "string",
      label: "Sam's environment path",
      description: "Only top-level threads titled Sam that run in this directory are read.",
      default: "/home/ratul/assistants/sam",
    },
    scriptDir: {
      type: "string",
      label: "Scribe folder",
      description: "Holds observe.py, its prompt and its cursor file.",
      default: "/home/ratul/assistants/sam/memory",
    },
    quietSeconds: {
      type: "string",
      label: "Quiet window (seconds)",
      description: "How long a thread stays idle before its new turns are read.",
      default: "120",
    },
  });
  // The SDK types settings loosely, so read them through these.
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });
  const samEnvPath = () => String(current.samEnvPath ?? "/home/ratul/assistants/sam").replace(/\/+$/, "");
  const scriptDir = () => String(current.scriptDir ?? "/home/ratul/assistants/sam/memory");
  const quietMs = () => {
    const seconds = Number.parseInt(String(current.quietSeconds ?? "120"), 10);
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : 120) * 1000;
  };

  // Environment ids are stable while the environment lives, so one lookup each.
  const envPaths = new Map<string, string | null>();
  async function environmentPath(environmentId: string): Promise<string | null> {
    const known = envPaths.get(environmentId);
    if (known !== undefined) return known;
    try {
      const path = (await bb.sdk.environments.get({ environmentId })).path ?? null;
      envPaths.set(environmentId, path);
      return path;
    } catch (error) {
      bb.log.warn(`environment ${environmentId} lookup failed: ${message(error)}`);
      return null;
    }
  }

  // Same rule as observe.py's sam_threads(): Ratul-facing Sam threads only.
  async function isSamThread(thread: ThreadLike): Promise<boolean> {
    if (thread.parentThreadId || thread.visibility !== "visible" || !thread.environmentId) return false;
    if ((thread.title ?? "").trim() !== "Sam") return false;
    const path = await environmentPath(thread.environmentId);
    return path !== null && path.replace(/\/+$/, "") === samEnvPath();
  }

  function runObserve(threadIds: string[] | null, signal: AbortSignal): Promise<void> {
    const args = ["observe.py", ...(threadIds ? ["--threads", threadIds.join(",")] : [])];
    bb.log.info(`running ${threadIds ? threadIds.join(",") : "sweep"}`);
    return new Promise((resolve, reject) => {
      const child = spawn("python3", args, {
        cwd: scriptDir(),
        signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out = tail(out + chunk.toString());
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err = tail(err + chunk.toString());
      });
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        for (const line of out.split("\n")) {
          if (line.trim()) bb.log.info(line.trim());
        }
        if (code === 0) {
          resolve();
        } else if (code === EXIT_NO_MODEL) {
          bb.log.warn("no local model loaded; the next idle or sweep will try again");
          resolve();
        } else {
          const why = err.trim().split("\n").slice(-3).join(" | ");
          reject(new Error(`observe.py exited ${code}: ${why}`));
        }
      });
    });
  }

  const runner = new ScribeRunner({
    quietMs,
    run: runObserve,
    log: bb.log,
  });

  bb.events.on("thread.idle", async ({ thread }) => {
    // A parent goes idle while its delegated agents still run; the real end comes later.
    if (thread.activeBackgroundAgentCount > 0) return;
    if (await isSamThread(thread)) runner.touch(thread.id);
  });
  bb.events.on("thread.active", ({ thread }) => runner.cancel(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => runner.cancel(thread.id));
  bb.events.on("thread.archived", ({ thread }) => runner.cancel(thread.id));

  bb.background.schedule("sweep", "17 * * * *", async () => {
    runner.sweep();
  });

  bb.cli.register({
    name: "sam-scribe",
    summary: "Run Sam's scribe over new turns now",
    commands: [{ name: "run", summary: "Read every Sam thread from its cursor now", usage: "bb sam-scribe run" }],
    async run(argv) {
      if (argv[0] !== "run") {
        return { exitCode: 1, stderr: "usage: bb sam-scribe run\n" };
      }
      runner.sweep();
      return { exitCode: 0, stdout: "queued; watch `bb plugin logs sam-scribe -f`\n" };
    },
  });

  bb.onDispose(() => runner.dispose());
}
