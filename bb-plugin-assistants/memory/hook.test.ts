import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_COMMAND, HOOK_SCRIPT } from "./hook";
import { IDENTITY, world } from "./world";

const dirs: string[] = [];
const worlds: Array<ReturnType<typeof world>> = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const w of worlds.splice(0)) await w.dispose();
});

/** Runs `command` as Claude Code would, with a fake `bb` that prints `stdout` and exits `code`. */
function runIn(home: string, command: string, { stdout = "", code = 0, source = "startup", threadId = "thr_main" as string | null } = {}) {
  const bb = path.join(home, "fake-bb");
  fs.writeFileSync(bb, `#!/bin/sh\necho "$@" > "${home}/args"\n${code !== 0 ? 'echo "plugin not running" >&2; exit 1' : `printf '%s' '${stdout}'`}\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, BB_CLI: bb, CLAUDE_PROJECT_DIR: home, ...(threadId ? { BB_THREAD_ID: threadId } : {}) };
  return execFileSync("sh", ["-c", command], { env, input: JSON.stringify({ source }) }).toString();
}

/** The script alone, in a fresh home. */
function run(options: Parameters<typeof runIn>[2] = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hook-home-"));
  dirs.push(home);
  fs.writeFileSync(path.join(home, "hook.sh"), HOOK_SCRIPT);
  const again = (over: Parameters<typeof runIn>[2] = {}) => runIn(home, `sh "${home}/hook.sh"`, { ...options, ...over });
  return { out: again(), home, file: path.join(home, "nosync", `bb-memory-${options.threadId === undefined ? "thr_main" : options.threadId}.md`), again };
}

describe("memory SessionStart hook script", () => {
  it("writes the main chat's memory under nosync and points the agent at it", () => {
    const { out, file, home } = run({ stdout: "# Memory\n<chat>\n</chat>" });
    expect(fs.readFileSync(file, "utf8")).toBe("# Memory\n<chat>\n</chat>\n");
    expect(out).toContain(`Before you reply or do anything else, read ${file} in full`);
    expect(fs.readFileSync(path.join(home, "args"), "utf8").trim()).toBe(`assistants memory view --home ${home}`);
  });

  it("leaves every other session alone: empty answer, no thread, or a resume", () => {
    for (const r of [run({ stdout: "" }), run({ stdout: "x", threadId: null }), run({ stdout: "x", source: "resume" })]) {
      expect(r.out).toBe("");
      expect(fs.existsSync(path.join(r.home, "nosync"))).toBe(false);
    }
  });

  it("stays quiet when the plugin fails for a chat it never served, and warns one it did", () => {
    expect(run({ code: 1 }).out).toBe("");
    const served = run({ stdout: "# Memory" });
    expect(served.again({ code: 1 })).toMatch(/could not be loaded .*may be stale.*`bb assistants recall`/);
    expect(fs.readFileSync(served.file, "utf8")).toBe("# Memory\n");
  });
});

describe("memory on and off install and remove the hook in the home", () => {
  const settingsOf = (home: string) => path.join(home, ".claude", "settings.json");
  const theirs = { outputStyle: "zz", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo theirs" }] }], Stop: [{ hooks: [{ type: "command", command: "true" }] }] } };

  it("adds one entry beside the home's own settings, whose command runs the script, and takes only that out again", async () => {
    const w = world();
    worlds.push(w);
    const svc = w.service();
    fs.mkdirSync(path.join(w.home, ".claude"));
    fs.writeFileSync(settingsOf(w.home), JSON.stringify(theirs));
    await svc.on("thr_main");
    await svc.on("thr_main");
    const settings = JSON.parse(fs.readFileSync(settingsOf(w.home), "utf8"));
    expect(settings.outputStyle).toBe("zz");
    expect(settings.hooks.Stop).toEqual(theirs.hooks.Stop);
    expect(settings.hooks.SessionStart).toEqual([...theirs.hooks.SessionStart, { hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 30 }] }]);

    expect(runIn(w.home, HOOK_COMMAND, { stdout: "# Memory" })).toContain("read ");
    expect(fs.readFileSync(path.join(w.home, "nosync", "bb-memory-thr_main.md"), "utf8")).toBe("# Memory\n");
    // A command the user later puts into the same group stays at off.
    settings.hooks.SessionStart[1].hooks.push({ type: "command", command: "echo sibling" });
    fs.writeFileSync(settingsOf(w.home), JSON.stringify(settings));

    await svc.off(IDENTITY, "thr_main");
    expect(JSON.parse(fs.readFileSync(settingsOf(w.home), "utf8"))).toEqual({
      ...theirs,
      hooks: { ...theirs.hooks, SessionStart: [...theirs.hooks.SessionStart, { hooks: [{ type: "command", command: "echo sibling" }] }] },
    });
    expect(fs.existsSync(path.join(w.home, ".claude", "hooks", "bb-memory-session-start.sh"))).toBe(false);
  });

  it("puts a lost hook back at the next plugin load, warns the main chat if its very first load fails, and comes off for an archived main chat", async () => {
    const w = world();
    worlds.push(w);
    let svc = w.service();
    await svc.on("thr_main");
    await svc.dispose();
    fs.rmSync(path.join(w.home, ".claude"), { recursive: true });
    svc = w.service();
    await svc.start();
    expect(runIn(w.home, HOOK_COMMAND, { code: 1 })).toMatch(/could not be loaded .*may be stale/);
    expect(runIn(w.home, HOOK_COMMAND, { code: 1, threadId: "thr_helper" })).toBe("");

    await w.bb.sdk.threads.archive({ threadId: "thr_main" });
    await svc.onGone("thr_main", "archived");
    await svc.off(IDENTITY, "thr_main");
    expect(JSON.parse(fs.readFileSync(settingsOf(w.home), "utf8"))).toEqual({});
  });

  it("creates the settings in a home that has none, and leaves no hooks key behind at off", async () => {
    const w = world();
    worlds.push(w);
    const svc = w.service();
    await svc.on("thr_main");
    expect(JSON.parse(fs.readFileSync(settingsOf(w.home), "utf8")).hooks.SessionStart).toHaveLength(1);
    await svc.off(IDENTITY, "thr_main");
    expect(JSON.parse(fs.readFileSync(settingsOf(w.home), "utf8"))).toEqual({});
  });

  it("refuses to turn memory on over a settings file it cannot read, or for a harness the hook does not reach", async () => {
    const w = world();
    worlds.push(w);
    const svc = w.service();
    w.thread("thr_codex", { providerId: "codex" });
    await expect(svc.on("thr_codex")).rejects.toThrow(/needs a Claude Code thread/);
    fs.mkdirSync(path.join(w.home, ".claude"));
    fs.writeFileSync(settingsOf(w.home), '{ "outputStyle": "zz", }');
    await expect(svc.on("thr_main")).rejects.toThrow(/settings\.json: .*fix it, then try again/);
    expect(fs.readFileSync(settingsOf(w.home), "utf8")).toBe('{ "outputStyle": "zz", }');
    expect(svc.state(IDENTITY).on).toBe(false);
  });
});
