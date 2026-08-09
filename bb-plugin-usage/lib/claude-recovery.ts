import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

export const CLAUDE_RECOVERY_TIMEOUT_MS = 10_000;
export const CLAUDE_RECOVERY_KILL_GRACE_MS = 1_000;
export const CLAUDE_STATUS_DELAY_MS = 4_000;
export const CLAUDE_EXIT_DELAY_MS = 4_000;

const SCRIPT_PATH = "/usr/bin/script";
const CLAUDE_SESSION_ID = "7b1f0a70-7aa0-4d88-9f55-a7ec637e76af";
const CLAUDE_COMMAND = `claude --safe-mode --allowed-tools '' --session-id ${CLAUDE_SESSION_ID}`;
const CLAUDE_STATUS_INPUT = "/status\r";
const CLAUDE_EXIT_INPUT = "/exit\r";

type SpawnProcess = typeof spawn;
type ProcessSignal = NodeJS.Signals;

function recoveryEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !name.startsWith("ANTHROPIC_") &&
        name !== "CLAUDE_CODE_OAUTH_TOKEN",
    ),
  );
}

export function createClaudeCredentialRecovery({
  spawnProcess = spawn,
  killProcessGroup = (pid: number, signal: ProcessSignal) => {
    process.kill(-pid, signal);
  },
  env = process.env,
  homeDirectory,
  timeoutMs = CLAUDE_RECOVERY_TIMEOUT_MS,
  killGraceMs = CLAUDE_RECOVERY_KILL_GRACE_MS,
  statusDelayMs = CLAUDE_STATUS_DELAY_MS,
  exitDelayMs = CLAUDE_EXIT_DELAY_MS,
}: {
  spawnProcess?: SpawnProcess;
  killProcessGroup?: (pid: number, signal: ProcessSignal) => void;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  statusDelayMs?: number;
  exitDelayMs?: number;
} = {}) {
  let disposed = false;
  const terminationGraceMs = Math.max(
    0,
    Math.min(killGraceMs, timeoutMs),
  );
  const active = new Set<{
    done: Promise<void>;
    terminate: () => void;
  }>();

  function recover(): Promise<void> {
    if (disposed) {
      return Promise.reject(new Error("Claude credential recovery failed"));
    }

    let child: ChildProcess;
    try {
      child = spawnProcess(
        SCRIPT_PATH,
        [
          "--quiet",
          "--flush",
          "--return",
          "--command",
          CLAUDE_COMMAND,
          "/dev/null",
        ],
        {
          cwd: homeDirectory ?? env.HOME ?? homedir(),
          detached: true,
          env: recoveryEnvironment(env),
          shell: false,
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
    } catch {
      return Promise.reject(new Error("Claude credential recovery failed"));
    }

    let timeout: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let statusTimer: NodeJS.Timeout | null = null;
    let exitTimer: NodeJS.Timeout | null = null;
    let terminating = false;
    let settled = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;

    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const probe = { done, terminate };
    active.add(probe);

    function signal(signal: ProcessSignal) {
      if (child.pid === undefined) return;
      try {
        killProcessGroup(child.pid, signal);
      } catch {
        // The process group may already be gone.
      }
    }

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (statusTimer) clearTimeout(statusTimer);
      if (exitTimer) clearTimeout(exitTimer);
      active.delete(probe);
      if (error) rejectDone(error);
      else resolveDone();
    }

    function terminate() {
      if (settled || terminating) return;
      terminating = true;
      if (timeout) clearTimeout(timeout);
      if (statusTimer) clearTimeout(statusTimer);
      if (exitTimer) clearTimeout(exitTimer);
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        signal("SIGKILL");
        finish();
      }, terminationGraceMs);
    }

    function fail() {
      signal("SIGTERM");
      signal("SIGKILL");
      finish(new Error("Claude credential recovery failed"));
    }

    child.once("close", () => {
      if (!terminating) finish();
    });
    child.once("error", fail);
    child.stdin?.once("error", fail);

    timeout = setTimeout(terminate, timeoutMs - terminationGraceMs);
    statusTimer = setTimeout(() => {
      if (settled || terminating) return;
      try {
        child.stdin?.write(CLAUDE_STATUS_INPUT);
      } catch {
        fail();
        return;
      }

      exitTimer = setTimeout(() => {
        if (settled || terminating) return;
        try {
          child.stdin?.write(CLAUDE_EXIT_INPUT);
          child.stdin?.end();
        } catch {
          fail();
        }
      }, exitDelayMs);
    }, statusDelayMs);

    return done;
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const probes = [...active];
    for (const probe of probes) probe.terminate();
    await Promise.allSettled(probes.map((probe) => probe.done));
  }

  return { recover, dispose };
}
