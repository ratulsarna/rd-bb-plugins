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
            column: input.column,
            last_message: text.slice(-4_000),
          },
          model: "jev-latest",
          questions: {
            needs_user: {
              type: "noul",
              instructions:
                "The assistant's message ends its turn by asking the user a question, asking the user to decide something, or asking the user to review something before the work can continue.",
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
