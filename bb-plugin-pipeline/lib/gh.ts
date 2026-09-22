import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 20_000;
const GH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function failureMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);

  const error = cause as Error & {
    code?: string | number;
    killed?: boolean;
    stderr?: string | Buffer;
  };
  if (error.name === "AbortError" || error.code === "ABORT_ERR") {
    return "request was aborted";
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `response exceeded ${GH_MAX_OUTPUT_BYTES} bytes`;
  }
  if (error.killed) return `request exceeded ${GH_TIMEOUT_MS}ms`;

  const stderr = typeof error.stderr === "string"
    ? error.stderr
    : error.stderr?.toString("utf8");
  return (stderr?.trim() || error.message).slice(0, 2_000);
}

export async function runGh(args: readonly string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", [...args], {
      encoding: "utf8",
      maxBuffer: GH_MAX_OUTPUT_BYTES,
      signal,
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch (cause) {
    throw new Error(`gh failed: ${failureMessage(cause)}`);
  }
}
