import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { codeSchema, type Login, type Probe } from "../contract";

import { isActive } from "./state";

type Lease = { dispose(): Promise<void> };
export type LoginDependencies = {
  probe(): Promise<Omit<Probe, "login">>;
  spawn(): ChildProcessWithoutNullStreams;
  kill(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void;
  timeoutMs?: number;
};

export function findLoginUrl(output: string): string | null {
  const clean = stripVTControlCharacters(output);
  for (const match of clean.matchAll(/https:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(match[0]);
      if (
        ["claude.com", "claude.ai"].includes(url.hostname) &&
        url.pathname.endsWith("/oauth/authorize") &&
        url.searchParams.has("state") &&
        url.searchParams.has("code_challenge")
      ) {
        const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
        if (
          callback.protocol === "https:" &&
          ["platform.claude.com", "console.anthropic.com"].includes(
            callback.hostname,
          ) &&
          callback.pathname === "/oauth/code/callback"
        )
          return url.href;
      }
    } catch {
      /* Wait for the next output chunk if the URL is incomplete. */
    }
  }
  return null;
}

export function createLoginManager(deps: LoginDependencies) {
  let login: Login | null = null;
  let active: {
    child: ChildProcessWithoutNullStreams | null;
    release: () => Promise<void>;
    timer: ReturnType<typeof setTimeout> | null;
    stop: () => Promise<void>;
  } | null = null;
  let cached: Omit<Probe, "login"> | null = null;
  let checkedAt = 0;
  let checking: Promise<Omit<Probe, "login">> | null = null;
  let disposed = false;
  const copy = () => (login === null ? null : { ...login });

  async function inspect(refresh = false): Promise<Probe> {
    if (
      !cached ||
      ((refresh || Date.now() - checkedAt > 30_000) && !isActive(login))
    ) {
      checking ??= deps.probe().finally(() => {
        checking = null;
      });
      cached = await checking;
      checkedAt = Date.now();
    }
    return { ...cached, login: copy() };
  }

  async function start(retain: () => Lease): Promise<Login> {
    if (disposed) throw new Error("The plugin is restarting. Try again.");
    if (isActive(login))
      throw new Error("A login is already running on this machine.");
    const current: Login = {
      id: randomUUID(),
      phase: "starting",
      url: null,
      message: "Starting Claude login...",
      expiresAt: Date.now() + (deps.timeoutMs ?? 10 * 60_000),
    };
    login = current;
    const lease = retain();
    let released = false;
    const release = async () => {
      if (!released) {
        released = true;
        await lease.dispose();
      }
    };
    const run = {
      child: null as ChildProcessWithoutNullStreams | null,
      release,
      timer: null as ReturnType<typeof setTimeout> | null,
      stop: async () => {},
    };
    active = run;
    try {
      cached = await deps.probe();
      checkedAt = Date.now();
      if (!cached.available || cached.issue)
        throw new Error(cached.issue ?? "Claude Code is not installed.");
      if (disposed || login !== current || current.phase !== "starting")
        throw new Error("Login cancelled.");
      const child = deps.spawn();
      run.child = child;
      let output = "";
      let closed = false;
      let resolveClosed!: () => void;
      const onClosed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      run.stop = async () => {
        if (run.timer) clearTimeout(run.timer);
        if (!closed) {
          deps.kill(child, "SIGTERM");
          const force = setTimeout(() => deps.kill(child, "SIGKILL"), 500);
          await Promise.race([
            onClosed,
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
          clearTimeout(force);
        }
        await release();
      };
      const fail = (message: string) => {
        if (!isActive(current)) return;
        current.phase = "error";
        current.message = message;
        current.url = null;
        void run.stop();
      };
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-24_000);
        // Wait for the prompt so a split URL cannot escape to the browser.
        if (
          current.phase === "starting" &&
          stripVTControlCharacters(output).includes("Paste code here")
        ) {
          const url = findLoginUrl(output);
          if (!url) {
            fail(
              "Claude did not provide a supported remote login link. Update Claude Code and retry.",
            );
            return;
          }
          current.url = url;
          current.phase = "awaiting-code";
          current.message = "Open the login page, then paste its code here.";
          output = "";
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.stdin.on("error", () =>
        fail("Claude closed the login input. Start a new login."),
      );
      child.on("error", () => fail("Could not start Claude Code."));
      child.on("close", (code) => {
        closed = true;
        output = "";
        resolveClosed();
        if (run.timer) clearTimeout(run.timer);
        void (async () => {
          if (!isActive(current)) return;
          if (code !== 0) {
            current.phase = "error";
            current.message =
              "Claude login did not finish. Start a new login and request a fresh code.";
            return;
          }
          current.phase = "verifying";
          current.message = "Checking the signed-in account...";
          try {
            const result = await deps.probe();
            if (login !== current || !isActive(current)) return;
            cached = result;
            checkedAt = Date.now();
            const actual = result.identity?.email;
            if (result.issue || !actual) {
              current.phase = "error";
              current.message =
                "Login finished, but the account could not be verified. Refresh to check before retrying.";
            } else {
              current.phase = "success";
              current.message = `Signed in as ${actual}. Resume your paused Claude sessions.`;
            }
          } catch {
            current.phase = "error";
            current.message =
              "Login finished, but the account check failed. Refresh before retrying.";
          }
        })().finally(() => {
          current.url = null;
          void release();
        });
      });
      run.timer = setTimeout(
        () => {
          if (!isActive(current)) return;
          current.phase = "expired";
          current.url = null;
          current.message = "This login expired. Start again for a fresh link.";
          void run.stop();
        },
        Math.max(0, current.expiresAt - Date.now()),
      );
      return { ...current };
    } catch (error) {
      current.phase = "error";
      current.message =
        error instanceof Error ? error.message : "Could not start login.";
      await release();
      return { ...current };
    }
  }

  function requireLogin(id: string): Login {
    if (!login || login.id !== id)
      throw new Error("This login is no longer current. Refresh the page.");
    return login;
  }
  function submit(id: string, code: string): Login {
    const current = requireLogin(id);
    code = codeSchema.parse(code);
    if (current.phase !== "awaiting-code" || !active?.child)
      throw new Error("This login is not waiting for a code.");
    current.phase = "verifying";
    current.url = null;
    current.message = "Completing login...";
    active.child.stdin.write(code + "\n");
    return { ...current };
  }
  async function cancel(id: string): Promise<Login> {
    const current = requireLogin(id);
    if (current.phase === "verifying")
      throw new Error(
        "The code is already being exchanged. Wait for the result.",
      );
    if (isActive(current)) {
      current.phase = "cancelled";
      current.url = null;
      current.message = "Login cancelled.";
      await active?.stop();
      await active?.release();
    }
    return { ...current };
  }
  async function dispose() {
    disposed = true;
    if (login && isActive(login)) {
      login.phase = "cancelled";
      login.url = null;
      login.message = "Login stopped because the plugin restarted.";
    }
    await active?.stop();
    await active?.release();
  }
  return { inspect, start, submit, cancel, dispose };
}
