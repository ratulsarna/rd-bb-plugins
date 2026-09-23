export function parseThreshold(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 1 ? parsed : 0.7;
}

export type JevDecision = "needs" | "no" | "unknown";

export interface JevResult {
  decision: JevDecision;
  probability: number | null;
}

type FetchLike = typeof fetch;

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: {
    true: string;
    false: string;
  };
}

export interface JevResponse {
  value: unknown | null;
  body: string;
  reason?: string;
}

const MODEL = "jev-latest";

function preview(value: string, apiKey?: string): string {
  let safe = value.slice(0, 200).replace(/[\r\n]+/g, " ");
  if (apiKey) safe = safe.split(apiKey).join("[redacted]");
  return safe;
}

function withBody(reason: string, body: string, apiKey?: string): string {
  const detail = preview(body, apiKey);
  return detail === "" ? reason : `${reason} ${detail}`;
}

export function logJevDecision(
  log: ((message: string) => void) | undefined,
  summary: string,
  decision: string,
  reason?: string,
): void {
  log?.(
    `Jev model=${MODEL} ${summary} decision=${decision}${reason === undefined ? "" : ` reason=${reason}`}`,
  );
}

export function thresholdNoul(
  probability: number,
  threshold: number,
): "yes" | "no" | "unknown" {
  if (probability >= threshold) return "yes";
  if (probability <= 1 - threshold) return "no";
  return "unknown";
}

export async function requestJev(input: {
  apiKey: string | undefined;
  state: unknown;
  questions: Record<string, JevNoulQuestion>;
  fetch?: FetchLike;
}): Promise<JevResponse> {
  if (!input.apiKey) return { value: null, body: "", reason: "no-key" };

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
          state: input.state,
          model: MODEL,
          questions: input.questions,
        }),
        signal: controller.signal,
      },
    );
    const body = await response.text();
    if (!response.ok) {
      return {
        value: null,
        body,
        reason: withBody(`http ${response.status}`, body, input.apiKey),
      };
    }
    try {
      return { value: JSON.parse(body) as unknown, body };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return {
        value: null,
        body,
        reason: `error ${preview(error.name, input.apiKey)}: ${preview(error.message, input.apiKey)}`,
      };
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return {
      value: null,
      body: "",
      reason: `error ${preview(error.name, input.apiKey)}: ${preview(error.message, input.apiKey)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

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
  lastText: string | null;
  fetch?: FetchLike;
  log?: (message: string) => void;
}): Promise<JevResult> {
  const finish = (
    decision: JevDecision,
    probability: number | null,
    reason?: string,
  ): JevResult => {
    logJevDecision(
      input.log,
      `noul=${probability === null ? "null" : probability.toFixed(4)}`,
      decision,
      reason,
    );
    return { decision, probability };
  };
  const text = input.lastText?.trim() ?? "";
  if (text === "") return finish("unknown", null, "blank-text");
  const response = await requestJev({
    apiKey: input.apiKey,
    state: {
      last_message_from_agent_to_human: text.slice(-4_000),
    },
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
    fetch: input.fetch,
  });
  if (response.reason !== undefined) {
    return finish("unknown", null, response.reason);
  }
  const probability = extractProbability(response.value);
  if (probability === null || probability < 0 || probability > 1) {
    return finish(
      "unknown",
      null,
      withBody("no-probability", response.body, input.apiKey),
    );
  }
  const band = thresholdNoul(probability, input.threshold);
  const decision: JevDecision = band === "yes" ? "needs" : band;
  return finish(
    decision,
    probability,
    decision === "unknown" ? "threshold-gap" : undefined,
  );
}
