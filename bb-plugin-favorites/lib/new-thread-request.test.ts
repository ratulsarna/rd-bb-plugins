import { describe, expect, it } from "vitest";
import { isNewThreadRequest } from "./new-thread-request";

const valid = {
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

describe("isNewThreadRequest", () => {
  it("accepts a complete composer request including execution sources", () => {
    expect(isNewThreadRequest(valid)).toBe(true);
  });

  it("rejects a request that dropped execution sources", () => {
    const { executionInputSources: _, ...rest } = valid;
    expect(isNewThreadRequest(rest)).toBe(false);
  });
});
