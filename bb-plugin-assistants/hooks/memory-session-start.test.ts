import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "memory-session-start.sh");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** Runs the hook with a fake `bb` that prints `stdout` and exits `code`; `again` reruns it in the same home. */
function run({ stdout = "", code = 0, source = "startup", threadId = "thr_main" as string | null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hook-home-"));
  dirs.push(home);
  const bb = path.join(home, "fake-bb");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, BB_CLI: bb, CLAUDE_PROJECT_DIR: home, ...(threadId ? { BB_THREAD_ID: threadId } : {}) };
  const again = (over: { stdout?: string; code?: number; source?: string } = {}) => {
    const fail = (over.code ?? code) !== 0;
    fs.writeFileSync(bb, `#!/bin/sh\necho "$@" > "${home}/args"\n${fail ? 'echo "plugin not running" >&2; exit 1' : `printf '%s' '${over.stdout ?? stdout}'`}\n`, { mode: 0o755 });
    return execFileSync("sh", [SCRIPT], { env, input: JSON.stringify({ source: over.source ?? source }) }).toString();
  };
  return { out: again(), home, file: path.join(home, "nosync", `bb-memory-${threadId}.md`), again };
}

describe("memory SessionStart hook", () => {
  it("writes the main chat's memory under nosync and points the agent at it", () => {
    const { out, file, home } = run({ stdout: "# Memory\n<chat>\n</chat>" });
    expect(fs.readFileSync(file, "utf8")).toBe("# Memory\n<chat>\n</chat>\n");
    expect(out).toContain(`Your memory is in ${file}`);
    expect(fs.readFileSync(path.join(home, "args"), "utf8").trim()).toBe(`assistants memory view --home ${home}`);
  });

  it("leaves every other session alone: empty answer, no thread, or a resume", () => {
    for (const r of [run({ stdout: "" }), run({ stdout: "x", threadId: null }), run({ stdout: "x", source: "resume" })]) {
      expect(r.out).toBe("");
      expect(fs.existsSync(path.join(r.home, "nosync"))).toBe(false);
    }
  });

  it("stays quiet when the plugin fails for a chat it never served, and warns one it did", () => {
    const fresh = run({ code: 1 });
    expect(fresh.out).toBe("");
    const served = run({ stdout: "# Memory" });
    const warned = served.again({ code: 1 });
    expect(warned).toMatch(/could not be loaded \(plugin not running\).*may be stale/);
    expect(fs.readFileSync(served.file, "utf8")).toBe("# Memory\n");
  });
});
