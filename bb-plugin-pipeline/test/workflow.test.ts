import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createPipelineCli } from "../lib/cli";
import { intakePrompt, leadPrompt } from "../lib/prompts";
import { resumeInstruction } from "../lib/control-prompts";
import { reviewFollowup } from "../lib/github-sync";
import { makeCard } from "./sdk-fake";

const cli = createPipelineCli({} as never);
const context = { cwd: "/remote-machine/unrelated-checkout", signal: new AbortController().signal };

describe("workflow document delivery", () => {
  it("serves every shipped document intact without a task, project, or local checkout", async () => {
    const root = new URL("../workflows/", import.meta.url);
    const files = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".md"));
    expect(files).toContain("README.md");
    for (const path of files) {
      const [phase, ...parts] = path.split("/");
      const args = path === "README.md" ? [] : [phase!, "--file", parts.join("/")];
      const result = await cli.run(["instructions", ...args, "--json"], context);
      expect(result.exitCode, path).toBe(0);
      expect(JSON.parse(result.stdout!).content, path).toBe(await readFile(new URL(path, root), "utf8"));
    }
  });

  it("resolves the phase and template commands in kickoffs and workflow handoffs", async () => {
    const card = makeCard({ issueUrl: "https://github.com/o/r/issues/1" });
    const documents = [
      intakePrompt(card, "Example"),
      leadPrompt(card, { title: "Feature", body: "Details", labels: [] }),
      resumeInstruction({ ...card, ownerRole: "lead" }),
      resumeInstruction({ ...card, ownerRole: "intake" }),
      reviewFollowup(card, {
        id: "batch_1", headSha: "abc", feedback: [], threadId: "lead", queueId: null, state: "pending",
      }),
    ];
    const visited = new Set<string>();
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index]!;
      expect(document).not.toMatch(/bb skill (?:show|list)|pipeline-(?:intake|plan|implement|debug|close-out)/);
      const commands = [...document.matchAll(/`(bb pipeline instructions[^`\n]*)`/g)]
        .map((match) => match[1]!)
        .filter((command) => !/[<>[\]|]/.test(command));
      for (const command of commands) {
        if (visited.has(command)) continue;
        visited.add(command);
        const result = await cli.run(command.split(" ").slice(2), context);
        expect(result.exitCode, command).toBe(0);
        if (!command.includes("--file")) documents.push(result.stdout!);
      }
    }
    for (const phase of ["intake", "plan", "implement", "debug", "close-out"]) {
      expect(visited).toContain(`bb pipeline instructions ${phase}`);
    }
  });

  it("rejects paths outside the selected phase and task mutation options", async () => {
    for (const args of [
      ["__proto__"], ["../intake"], ["implement", "extra"],
      ["overview", "--file", "README.md"],
      ["intake", "--file", "templates/developer.md"],
      ["implement", "--file", "../../package.json"],
      ["implement", "--file", "/etc/passwd"],
      ["implement", "--file", "%2e%2e/README.md"],
      ["plan", "--working"], ["plan", "--card", "card_1"],
    ]) {
      const result = await cli.run(["instructions", ...args], context);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stdout).toBeUndefined();
    }
    expect((await cli.run(["show", "card_1", "--file", "README.md"], context)).exitCode).toBe(1);
  });
});
