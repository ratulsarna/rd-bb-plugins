import { readFile } from "node:fs/promises";

const DOCUMENTS: Record<string, readonly string[]> = {
  overview: ["README.md"],
  intake: ["README.md"],
  plan: ["README.md", "templates/oracle.md"],
  implement: ["README.md", "templates/developer.md", "templates/oracle.md", "templates/qa.md"],
  debug: ["README.md", "templates/debugger.md"],
  "close-out": ["README.md"],
};

export async function readWorkflow(phase = "overview", requestedFile?: string) {
  if (!Object.hasOwn(DOCUMENTS, phase)) {
    throw new Error(`unknown workflow phase ${phase}; choose ${Object.keys(DOCUMENTS).join(", ")}`);
  }
  if (phase === "overview" && requestedFile !== undefined) {
    throw new Error("overview does not accept --file");
  }
  const file = requestedFile ?? "README.md";
  if (!DOCUMENTS[phase]!.includes(file)) {
    throw new Error(`unknown ${phase} document ${file}; choose ${DOCUMENTS[phase]!.join(", ")}`);
  }
  const path = phase === "overview" ? file : `${phase}/${file}`;
  // Both lib/workflow.ts and the bundled dist/server.js sit one level below the plugin root.
  const url = new URL(`../workflows/${path}`, import.meta.url);
  try {
    return { phase, file, content: await readFile(url, "utf8") };
  } catch {
    throw new Error(`Pipeline workflow document ${path} is unavailable; check the plugin installation`);
  }
}
