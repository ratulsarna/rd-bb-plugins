export interface VoiceEventRow {
  seq: number;
  type: string;
  scope: { kind: "thread" } | { kind: "turn"; turnId: string };
  data: unknown;
}

type EventPageLoader = (
  afterSeq: string,
  limit: string,
) => Promise<readonly VoiceEventRow[]>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function requestedText(row: VoiceEventRow): string | null {
  if (row.type !== "client/turn/requested") return null;
  const data = record(row.data);
  if (data?.initiator !== "user") return null;
  const input = data.input;
  if (!Array.isArray(input) || input.length !== 1) return null;
  const item = record(input[0]);
  return item?.type === "text" && item.visibility !== "agent-only" &&
      typeof item.text === "string"
    ? item.text
    : null;
}

export function findVoiceRequestId(
  rows: readonly VoiceEventRow[],
  transcript: string,
): string | null {
  for (const row of [...rows].sort((left, right) => left.seq - right.seq)) {
    if (requestedText(row) !== transcript) continue;
    const requestId = record(row.data)?.requestId;
    if (typeof requestId === "string") return requestId;
  }
  return null;
}

export function findTurnAnswer(
  rows: readonly VoiceEventRow[],
  requestId: string,
): { turnId: string; itemId: string | null; text: string | null } | null {
  const accepted = [...rows]
    .sort((left, right) => left.seq - right.seq)
    .find(
      (row) =>
        row.type === "turn/input/accepted" &&
        row.scope.kind === "turn" &&
        record(row.data)?.clientRequestId === requestId,
    );
  if (!accepted || accepted.scope.kind !== "turn") return null;

  let itemId: string | null = null;
  let text: string | null = null;
  for (const row of [...rows].sort((left, right) => left.seq - right.seq)) {
    if (
      row.type !== "item/completed" ||
      row.scope.kind !== "turn" ||
      row.scope.turnId !== accepted.scope.turnId
    ) {
      continue;
    }
    const item = record(record(row.data)?.item);
    if (
      item?.type !== "agentMessage" ||
      item.parentToolCallId != null ||
      typeof item.id !== "string" ||
      typeof item.text !== "string"
    ) {
      continue;
    }
    const candidate = item.text.trim();
    if (candidate) {
      itemId = item.id;
      text = item.text;
    }
  }
  return { turnId: accepted.scope.turnId, itemId, text };
}

export async function loadEventsAfter(
  baselineSeq: string,
  loadPage: EventPageLoader,
): Promise<VoiceEventRow[]> {
  const rows: VoiceEventRow[] = [];
  let afterSeq = baselineSeq;

  while (true) {
    const page = await loadPage(afterSeq, "100");
    rows.push(...page);
    if (page.length < 100) return rows;
    const lastSeq = page.at(-1)?.seq;
    if (lastSeq === undefined || lastSeq <= Number(afterSeq)) {
      throw new Error("thread event pagination did not advance");
    }
    afterSeq = String(lastSeq);
  }
}
