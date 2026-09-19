import { describe, expect, it, vi } from "vitest";
import { askJev } from "../lib/jev";

function response(probability: number) {
  return new Response(
    JSON.stringify({ answers: { needs_user: { noul: probability } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Jev decision", () => {
  it("sends the framed needs-you question and criteria", async () => {
    const lastText = `drop${"x".repeat(4_000)}`;
    const fetch = vi.fn(async () => response(0.9));

    await askJev({
      apiKey: "key",
      threshold: 0.7,
      column: "planning",
      lastText,
      fetch,
    });

    const request = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      state: {
        last_message_from_agent_to_human: lastText.slice(-4_000),
      },
      model: "jev-latest",
      questions: {
        needs_user: {
          type: "noul",
          instructions:
            "The state is the last message an AI coding agent sent to its human user before it stopped. Is the agent waiting on the human to answer a question, make a decision, or review something before the work can continue?",
          criteria: {
            true: "The message asks the human a question, or asks them to decide, approve, or review something, and the work is paused until they reply.",
            false:
              "The message only reports status, progress, or what the agent will do next, and does not need a reply.",
          },
        },
      },
    });
  });

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
