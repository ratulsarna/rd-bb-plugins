import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createPipelineCli } from "../lib/cli";

const cli = createPipelineCli({ getSettings: async () => ({}) } as never);
const context = { cwd: "/remote-machine/unrelated-checkout", signal: new AbortController().signal };

describe("workflow document delivery", () => {
  it("serves every shipped document intact without a task, project, or local checkout", async () => {
    const root = new URL("../workflows/", import.meta.url);
    const files = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".md"));
    expect(files).toContain("README.md");
    for (const path of files) {
      const [phase, ...parts] = path.split("/");
      const args = path === "README.md" ? [] : phase === "guidelines" ? ["guidelines"] : [phase!, "--file", parts.join("/")];
      const result = await cli.run(["instructions", ...args, "--json"], context);
      expect(result.exitCode, path).toBe(0);
      expect(JSON.parse(result.stdout!).content, path).toBe(await readFile(new URL(path, root), "utf8"));
    }
  });

  it("rejects paths outside the selected phase and task mutation options", async () => {
    for (const args of [
      ["__proto__"], ["../intake"], ["implement", "extra"],
      ["overview", "--file", "README.md"],
      ["guidelines", "--file", "README.md"],
      ["guidelines", "extra"],
      ["intake", "--file", "templates/developer.md"],
      ["implement", "--file", "../../package.json"],
      ["implement", "--file", "/etc/passwd"],
      ["implement", "--file", "%2e%2e/README.md"],
      ["plan", "--working"],
    ]) {
      const result = await cli.run(["instructions", ...args], context);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stdout).toBeUndefined();
    }
    expect((await cli.run(["show", "card_1", "--file", "README.md"], context)).exitCode).toBe(1);
  });
});
