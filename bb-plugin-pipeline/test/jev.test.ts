import { describe, expect, it, vi } from "vitest";
import { askJev } from "../lib/jev";

function response(probability: number) {
  return new Response(
    JSON.stringify({ answers: { needs_user: { noul: probability } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Jev decision", () => {
  it.each([
    [0.9, "needs"],
    [0.1, "no"],
    [0.5, "unknown"],
  ] as const)("maps probability %s to %s", async (probability, decision) => {
    const fetch = vi.fn(async () => response(probability));
    await expect(
      askJev({
        apiKey: "key",
        threshold: 0.7,
        column: "planning",
        lastText: "Do you approve?",
        fetch,
      }),
    ).resolves.toEqual({ decision, probability });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not fetch for null text or a missing key", async () => {
    const fetch = vi.fn();
    await expect(
      askJev({ apiKey: "key", threshold: 0.7, column: "planning", lastText: null, fetch }),
    ).resolves.toEqual({ decision: "unknown", probability: null });
    await expect(
      askJev({ apiKey: undefined, threshold: 0.7, column: "planning", lastText: "Question?", fetch }),
    ).resolves.toEqual({ decision: "unknown", probability: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats malformed and failed responses as unknown", async () => {
    const malformed = vi.fn(
      async () =>
        new Response('{"detail":"missing noul"}', { status: 200 }),
    );
    const failed = vi.fn(
      async () =>
        new Response('{"detail":"unauthorized"}', { status: 401 }),
    );
    const malformedLog = vi.fn();
    const failedLog = vi.fn();
    await expect(
      askJev({
        apiKey: "key",
        threshold: 0.7,
        column: "qa",
        lastText: "Question?",
        fetch: malformed,
        log: malformedLog,
      }),
    ).resolves.toEqual({ decision: "unknown", probability: null });
    await expect(
      askJev({
        apiKey: "key",
        threshold: 0.7,
        column: "qa",
        lastText: "Question?",
        fetch: failed,
        log: failedLog,
      }),
    ).resolves.toEqual({ decision: "unknown", probability: null });
    expect(malformedLog).toHaveBeenCalledWith(
      'Jev model=jev-latest noul=null decision=unknown reason=no-probability {"detail":"missing noul"}',
    );
    expect(failedLog).toHaveBeenCalledWith(
      'Jev model=jev-latest noul=null decision=unknown reason=http 401 {"detail":"unauthorized"}',
    );
  });
});
