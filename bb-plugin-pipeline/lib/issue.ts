import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IssueDetails {
  title: string;
  body: string;
  labels: string[];
}

export async function readIssue(url: string): Promise<IssueDetails> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "view", url, "--json", "title,body,labels"],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    const value = JSON.parse(stdout) as {
      title?: unknown;
      body?: unknown;
      labels?: Array<{ name?: unknown }>;
    };
    if (
      typeof value.title !== "string" ||
      typeof value.body !== "string" ||
      !Array.isArray(value.labels)
    ) {
      throw new Error("gh returned an invalid issue");
    }
    return {
      title: value.title,
      body: value.body,
      labels: value.labels.flatMap((label) =>
        typeof label.name === "string" ? [label.name] : [],
      ),
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not read ${url}: ${message}`);
  }
}
