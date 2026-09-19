export type JevDecision = "needs" | "no" | "unknown";

export interface JevResult {
  decision: JevDecision;
  probability: number | null;
}

type FetchLike = typeof fetch;

function extractProbability(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["noul", "probability", "value", "answer"]) {
    if (typeof record[key] === "number") return record[key];
  }
  for (const key of ["needs_user", "answers", "results", "questions"]) {
    const found = extractProbability(record[key]);
    if (found !== null) return found;
  }
  return null;
}

export async function askJev(input: {
  apiKey: string | undefined;
  threshold: number;
  column: string;
  lastText: string | null;
  fetch?: FetchLike;
  log?: (message: string) => void;
}): Promise<JevResult> {
  const preview = (value: string): string => {
    let safe = value.slice(0, 200).replace(/[\r\n]+/g, " ");
    if (input.apiKey) safe = safe.split(input.apiKey).join("[redacted]");
    return safe;
  };
  const withBody = (reason: string, body: string): string => {
    const detail = preview(body);
    return detail === "" ? reason : `${reason} ${detail}`;
  };
  const finish = (
    decision: JevDecision,
    probability: number | null,
    reason?: string,
  ): JevResult => {
    input.log?.(
      `Jev model=jev-latest noul=${probability === null ? "null" : probability.toFixed(4)} decision=${decision}${reason === undefined ? "" : ` reason=${reason}`}`,
    );
    return { decision, probability };
  };
  const text = input.lastText?.trim() ?? "";
  if (text === "") return finish("unknown", null, "blank-text");
  if (!input.apiKey) return finish("unknown", null, "no-key");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await (input.fetch ?? fetch)(
      "https://api.typesafe.ai/v1/systemone",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: {
            last_message_from_agent_to_human: text.slice(-4_000),
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
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return finish(
        "unknown",
        null,
        withBody(`http ${response.status}`, await response.text()),
      );
    }
    const body = response.clone();
    const probability = extractProbability(await response.json());
    if (probability === null || probability < 0 || probability > 1) {
      return finish(
        "unknown",
        null,
        withBody("no-probability", await body.text()),
      );
    }
    const decision: JevDecision =
      probability >= input.threshold
        ? "needs"
        : probability <= 1 - input.threshold
          ? "no"
          : "unknown";
    return finish(
      decision,
      probability,
      decision === "unknown" ? "threshold-gap" : undefined,
    );
  } catch (cause) {
    const error =
      cause instanceof Error ? cause : new Error(String(cause));
    return finish(
      "unknown",
      null,
      `error ${preview(error.name)}: ${preview(error.message)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
