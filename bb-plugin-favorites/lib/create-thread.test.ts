import { describe, expect, it } from "vitest";
import { spawnFromComposerRequest } from "./create-thread";

const request = {
  projectId: "proj_plugins",
  providerId: "codex",
  model: "gpt-5.6-sol",
  reasoningLevel: "xhigh",
  permissionMode: "auto",
  serviceTier: "fast",
  executionInputSources: {
    providerId: "explicit",
    model: "explicit",
    reasoningLevel: "explicit",
    serviceTier: "explicit",
  },
  environment: {
    type: "host",
    hostId: "host_mac",
    workspace: { type: "unmanaged", path: null },
  },
  input: [{ type: "text", text: "hello", mentions: [] }],
};

describe("spawnFromComposerRequest", () => {
  it("forwards the composer request unchanged", async () => {
    const calls: unknown[] = [];
    const result = await spawnFromComposerRequest(async (args) => {
      calls.push(args);
      return { id: "thr_new" };
    }, request);
    expect(result).toEqual({ threadId: "thr_new" });
    expect(calls).toEqual([request]);
  });

  it("rejects a request that dropped execution sources", async () => {
    const { executionInputSources: _, ...rest } = request;
    await expect(
      spawnFromComposerRequest(async () => ({ id: "thr_new" }), rest),
    ).rejects.toThrow("Expected a New Thread request.");
  });
});
