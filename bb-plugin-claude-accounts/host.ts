import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type Probe } from "./contract";
import { createLoginManager } from "./lib/login";

let executable: string | null = null;
async function findClaude(): Promise<string | null> {
  if (process.platform === "win32") return null;
  const candidates = [
    join(homedir(), ".local/bin/claude"),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((path) => join(path, "claude")),
  ];
  for (const path of [...new Set(candidates)]) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next installation. */
    }
  }
  return null;
}
async function probe(): Promise<Omit<Probe, "login">> {
  executable = await findClaude();
  if (!executable)
    return {
      available: false,
      identity: null,
      issue:
        process.platform === "win32"
          ? "Use the WSL machine for Claude Code."
          : "Claude Code is not installed.",
    };
  const overrides = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  ].filter((key) => process.env[key]);
  if (overrides.length)
    return {
      available: true,
      identity: null,
      issue: `This machine has a credential or gateway override: ${overrides.join(", ")}. Remove it before switching subscription accounts.`,
    };
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      executable!,
      ["auth", "status", "--json"],
      { timeout: 8000, maxBuffer: 32_000, encoding: "utf8" },
      (error, stdout) => {
        if (error && !stdout.trim())
          reject(
            new Error(
              "Could not read Claude's account. Check the installation and retry.",
            ),
          );
        else resolve(stdout);
      },
    );
  });
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(output);
  } catch {
    throw new Error(
      "Claude returned an unreadable account status. Update Claude Code and retry.",
    );
  }
  const email = typeof status.email === "string" ? status.email : null;
  const organization =
    typeof status.orgName === "string" ? status.orgName : null;
  const identity = status.loggedIn === true ? { email, organization } : null;
  const issue =
    status.loggedIn === true && status.authMethod !== "claude.ai"
      ? "Claude is using another authentication method. Check its API key or gateway settings before switching."
      : null;
  return { available: true, identity, issue };
}
const manager = createLoginManager({
  probe,
  spawn() {
    if (!executable) throw new Error("Claude Code is not installed.");
    return spawn(executable, ["auth", "login", "--claudeai"], {
      cwd: homedir(),
      detached: true,
      stdio: "pipe",
      env: {
        ...process.env,
        BROWSER: "/usr/bin/false",
        FORCE_COLOR: "0",
        TERM: "dumb",
      },
    });
  },
  kill(child, signal) {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* The login process has already exited. */
      }
    }
  },
});
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    inspect: ({ refresh }) => manager.inspect(refresh),
    start: (_, context) =>
      manager.start(() => context.experimental_retainWorker()),
    submit: ({ id, code }) => manager.submit(id, code),
    cancel: ({ id }) => manager.cancel(id),
  },
  dispose: () => manager.dispose(),
});
