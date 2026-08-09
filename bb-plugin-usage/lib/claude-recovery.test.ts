import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeCredentialRecovery } from "./claude-recovery";

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as ChildProcess;
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  Object.assign(child, {
    pid,
    stdin,
  });
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createClaudeCredentialRecovery", () => {
  it("runs only fixed local commands with no output or API-key environment", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const killProcessGroup = vi.fn();
    const recovery = createClaudeCredentialRecovery({
      spawnProcess: spawnProcess as unknown as typeof spawn,
      killProcessGroup,
      env: {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/home/ratul",
        CLAUDE_CONFIG_DIR: "/home/ratul/.claude",
        ANTHROPIC_API_KEY: "must-not-pass",
        ANTHROPIC_CUSTOM_HEADERS: "must-not-pass",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-pass",
      },
      homeDirectory: "/home/ratul",
    });

    const pending = recovery.recover();
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/script",
      [
        "--quiet",
        "--flush",
        "--return",
        "--command",
        "claude --safe-mode --allowed-tools '' --session-id 7b1f0a70-7aa0-4d88-9f55-a7ec637e76af",
        "/dev/null",
      ],
      {
        cwd: "/home/ratul",
        detached: true,
        env: {
          PATH: "/usr/local/bin:/usr/bin",
          HOME: "/home/ratul",
          CLAUDE_CONFIG_DIR: "/home/ratul/.claude",
        },
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    expect(child.stdin?.write).not.toHaveBeenCalled();
    expect(child.stdin?.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_999);
    expect(child.stdin?.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.stdin?.write).toHaveBeenCalledTimes(1);
    expect(child.stdin?.write).toHaveBeenLastCalledWith("/status\r");
    expect(child.stdin?.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_999);
    expect(child.stdin?.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.stdin?.write).toHaveBeenNthCalledWith(2, "/exit\r");
    expect(child.stdin?.end).toHaveBeenCalledOnce();
    expect(
      (child.stdin?.write as ReturnType<typeof vi.fn>).mock.calls
        .flat()
        .join(""),
    ).toBe("/status\r/exit\r");

    child.emit("close", 0, null);
    await pending;
    expect(killProcessGroup).not.toHaveBeenCalled();
  });

  it("reuses one fixed plugin session id across recoveries", async () => {
    const firstChild = fakeChild(1001);
    const secondChild = fakeChild(1002);
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const recovery = createClaudeCredentialRecovery({
      spawnProcess: spawnProcess as unknown as typeof spawn,
    });

    const first = recovery.recover();
    firstChild.emit("close", 0, null);
    await first;
    const second = recovery.recover();
    secondChild.emit("close", 0, null);
    await second;

    const commands = spawnProcess.mock.calls.map(
      (call) => (call[1] as string[])[4],
    );
    expect(commands).toEqual([
      "claude --safe-mode --allowed-tools '' --session-id 7b1f0a70-7aa0-4d88-9f55-a7ec637e76af",
      "claude --safe-mode --allowed-tools '' --session-id 7b1f0a70-7aa0-4d88-9f55-a7ec637e76af",
    ]);
  });

  it("terminates the whole process group on the hard timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const killProcessGroup = vi.fn();
    const recovery = createClaudeCredentialRecovery({
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
      killProcessGroup,
      timeoutMs: 20,
      killGraceMs: 5,
      statusDelayMs: 4,
      exitDelayMs: 4,
    });

    const pending = recovery.recover();
    await vi.advanceTimersByTimeAsync(8);
    expect(child.stdin?.write).toHaveBeenNthCalledWith(1, "/status\r");
    expect(child.stdin?.write).toHaveBeenNthCalledWith(2, "/exit\r");
    expect(child.stdin?.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6);
    expect(killProcessGroup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(killProcessGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    await vi.advanceTimersByTimeAsync(4);
    expect(killProcessGroup).not.toHaveBeenCalledWith(4242, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(killProcessGroup).toHaveBeenLastCalledWith(4242, "SIGKILL");
  });

  it("disposes an active probe with the same TERM-then-KILL cleanup", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const killProcessGroup = vi.fn();
    const recovery = createClaudeCredentialRecovery({
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
      killProcessGroup,
      timeoutMs: 1_000,
      killGraceMs: 5,
    });

    const pending = recovery.recover();
    const disposing = recovery.dispose();
    expect(killProcessGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    await vi.advanceTimersByTimeAsync(5);
    await Promise.all([pending, disposing]);
    expect(killProcessGroup).toHaveBeenLastCalledWith(4242, "SIGKILL");
  });

  it("does not start another probe after disposal", async () => {
    const spawnProcess = vi.fn(() => fakeChild());
    const recovery = createClaudeCredentialRecovery({
      spawnProcess: spawnProcess as unknown as typeof spawn,
    });

    await recovery.dispose();

    await expect(recovery.recover()).rejects.toThrow(
      "Claude credential recovery failed",
    );
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("does not expose child process errors", async () => {
    const child = fakeChild();
    const recovery = createClaudeCredentialRecovery({
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
      killProcessGroup: vi.fn(),
    });

    const pending = recovery.recover();
    child.emit("error", new Error("secret child output"));

    await expect(pending).rejects.toThrow("Claude credential recovery failed");
    await expect(pending).rejects.not.toThrow("secret child output");
  });
});
