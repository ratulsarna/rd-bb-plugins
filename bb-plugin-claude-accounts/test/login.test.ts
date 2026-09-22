import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoginManager, findLoginUrl } from "../lib/login";

const URL_TEXT =
  "https://claude.com/cai/oauth/authorize?code=true&state=test-state&code_challenge=test-challenge&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
const ok = (email: string) => ({
  available: true,
  identity: { email, organization: "Test" },
  issue: null,
});
function fixture() {
  let account = "personal@example.com";
  const children: (ChildProcessWithoutNullStreams & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
  })[] = [];
  const release = vi.fn(async () => {});
  const probe = vi.fn(async () => ok(account));
  const kill = vi.fn((child: ChildProcessWithoutNullStreams) =>
    child.emit("close", null),
  );
  const manager = createLoginManager({
    probe,
    timeoutMs: 1000,
    kill,
    spawn() {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
      }) as unknown as (typeof children)[number];
      children.push(child);
      return child;
    },
  });
  return {
    manager,
    children,
    probe,
    kill,
    release,
    retain: () => ({ dispose: release }),
    setAccount: (email: string) => {
      account = email;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("Claude login lifecycle", () => {
  it("waits for complete chunked output, sends a code once, and verifies the account", async () => {
    const f = fixture();
    const login = await f.manager.start(f.retain);
    const child = f.children[0];
    child.stdout.write(URL_TEXT.slice(0, 70));
    expect((await f.manager.inspect()).login?.url).toBeNull();
    child.stdout.write(URL_TEXT.slice(70) + "\nPaste code here if prompted > ");
    expect((await f.manager.inspect()).login?.url).toBe(URL_TEXT);
    const sent: string[] = [];
    child.stdin.on("data", (data) => sent.push(String(data)));
    f.manager.submit(login.id, "code#state");
    expect(() => f.manager.submit(login.id, "another")).toThrow("not waiting");
    expect(sent).toEqual(["code#state\n"]);
    expect(JSON.stringify(await f.manager.inspect())).not.toContain(
      "code#state",
    );
    f.setAccount("work@example.com");
    child.emit("close", 0);
    await vi.waitFor(async () =>
      expect((await f.manager.inspect()).login?.phase).toBe("success"),
    );
    expect((await f.manager.inspect()).login?.message).toContain(
      "work@example.com",
    );
    expect(f.release).toHaveBeenCalledTimes(1);
    await f.manager.dispose();
  });
  it("does not claim success when the account cannot be verified", async () => {
    const f = fixture();
    await f.manager.start(f.retain);
    f.probe.mockResolvedValueOnce(ok(""));
    f.children[0].emit("close", 0);
    await vi.waitFor(async () =>
      expect((await f.manager.inspect()).login?.phase).toBe("error"),
    );
    expect((await f.manager.inspect()).login?.message).toContain(
      "account could not be verified",
    );
    await f.manager.dispose();
  });
  it("reserves a machine before async probing, and rejects codes for old logins", async () => {
    const f = fixture();
    const first = f.manager.start(f.retain);
    await expect(f.manager.start(f.retain)).rejects.toThrow("already running");
    const login = await first;
    await f.manager.cancel(login.id);
    await f.manager.start(f.retain);
    expect(() => f.manager.submit(login.id, "stale")).toThrow(
      "no longer current",
    );
    await f.manager.dispose();
    expect(f.kill).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(2);
  });
  it("expires idle logins and does not expose raw errors or reflected codes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.manager.start(f.retain);
    f.children[0].stderr.write("access_token=do-not-return-this");
    await vi.advanceTimersByTimeAsync(1001);
    const result = await f.manager.inspect();
    expect(result.login?.phase).toBe("expired");
    expect(JSON.stringify(result)).not.toContain("do-not-return-this");
    expect(f.kill).toHaveBeenCalledOnce();
    await f.manager.dispose();
  });
  it("rejects newline injection and refuses cancellation once the code is submitted", async () => {
    const f = fixture();
    const login = await f.manager.start(f.retain);
    f.children[0].stdout.write(URL_TEXT + "\nPaste code here if prompted > ");
    expect(() => f.manager.submit(login.id, "code\nsecond-command")).toThrow();
    expect((await f.manager.inspect()).login?.phase).toBe("awaiting-code");
    f.manager.submit(login.id, "code");
    await expect(f.manager.cancel(login.id)).rejects.toThrow(
      "already being exchanged",
    );
    await f.manager.dispose();
  });
  it("does not spawn after cancellation during the initial account check", async () => {
    const f = fixture();
    let resolve!: (value: ReturnType<typeof ok>) => void;
    f.probe.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = f.manager.start(f.retain);
    await f.manager.dispose();
    resolve(ok("personal@example.com"));
    await pending;
    expect(f.children).toHaveLength(0);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("accepts only Anthropic's remote login URLs", () => {
    expect(
      findLoginUrl(URL_TEXT.replace("claude.com/", "evil.example/")),
    ).toBeNull();
    expect(
      findLoginUrl(
        URL_TEXT.replace(
          "https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
          "http%3A%2F%2Flocalhost%3A1234%2Fcallback",
        ),
      ),
    ).toBeNull();
  });
});
