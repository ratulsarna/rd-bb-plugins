import type { VoiceEventRow } from "./correlation";
import { SentenceAssembler, type Sentence } from "./sentencer";

export interface StreamState {
  cursorSeq: string;
  turnId: string | null;
  epoch: number;
  speakingItemId: string | null;
  suppressed: boolean;
  emittedChars: number;
  /** Internal state carried between pure reducer calls. */
  assembler?: SentenceAssembler;
  /** Set once the request row has been correlated. */
  requestId?: string | null;
  /** Internal root-item de-duplication. */
  rootItemIds?: readonly string[];
  /** Assistant items whose unplayed audio was invalidated by a later root. */
  invalidatedItemIds?: readonly string[];
}

export interface StreamBatch {
  epoch: number;
  itemId: string;
  sentences: Sentence[];
}

export interface ProcessEventsResult {
  state: StreamState;
  live: StreamBatch | null;
  invalidatePriorAudio: boolean;
  turnCompleted: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function isRoot(data: Record<string, unknown>): boolean {
  return data.parentToolCallId == null;
}

function itemFrom(row: VoiceEventRow): Record<string, unknown> | null {
  return record(record(row.data)?.item);
}

function isCurrentTurn(row: VoiceEventRow, turnId: string | null): boolean {
  return turnId !== null && row.scope.kind === "turn" && row.scope.turnId === turnId;
}

export function initialStreamState(
  cursorSeq = "0",
  requestId: string | null = null,
  turnId: string | null = null,
): StreamState {
  return {
    cursorSeq,
    turnId,
    epoch: 0,
    speakingItemId: null,
    suppressed: false,
    emittedChars: 0,
    assembler: new SentenceAssembler(),
    requestId,
    rootItemIds: [],
    invalidatedItemIds: [],
  };
}

/**
 * Applies one cursor-bounded event page without performing I/O. A fresh
 * assembler is installed whenever a new root assistant item takes over, and
 * batches from earlier epochs are deliberately discarded before returning.
 */
export function processEvents(
  state: StreamState,
  rows: readonly VoiceEventRow[],
  requestId: string | null = state.requestId ?? null,
): ProcessEventsResult {
  const next: StreamState = {
    ...state,
    assembler: state.assembler?.clone() ?? new SentenceAssembler(),
    requestId,
    rootItemIds: [...(state.rootItemIds ?? [])],
    invalidatedItemIds: [...(state.invalidatedItemIds ?? [])],
  };
  const ordered = [...rows].sort((left, right) => left.seq - right.seq);
  let cursor = Number(state.cursorSeq);
  let liveSentences: Sentence[] = [];
  let invalidatePriorAudio = false;
  let turnCompleted = false;

  const bumpRoot = (itemId: string, assistant: boolean): void => {
    if (next.rootItemIds!.includes(itemId)) return;

    const previousAssistant = next.speakingItemId;
    if (previousAssistant && !next.invalidatedItemIds!.includes(previousAssistant)) {
      next.invalidatedItemIds = [...next.invalidatedItemIds!, previousAssistant];
    }
    next.rootItemIds = [...next.rootItemIds!, itemId];
    next.epoch += 1;
    next.emittedChars = 0;
    next.assembler = new SentenceAssembler();
    next.speakingItemId = assistant ? itemId : null;
    next.suppressed = assistant ? false : Boolean(previousAssistant || next.suppressed);
    liveSentences = [];
    invalidatePriorAudio = true;
  };

  const feedAssistantText = (itemId: string, text: string): void => {
    if (next.speakingItemId !== itemId || !text) return;
    const assembler = next.assembler ?? new SentenceAssembler();
    next.assembler = assembler;
    liveSentences.push(...assembler.push(text));
    next.emittedChars += text.length;
  };

  for (const row of ordered) {
    if (row.seq <= cursor) continue;
    cursor = row.seq;

    if (next.turnId === null && row.type === "turn/input/accepted") {
      if (
        row.scope.kind === "turn" &&
        (requestId === null || record(row.data)?.clientRequestId === requestId)
      ) {
        next.turnId = row.scope.turnId;
      }
    }

    if (next.turnId === null || !isCurrentTurn(row, next.turnId)) continue;

    if (row.type === "turn/completed") {
      turnCompleted = true;
      continue;
    }

    if (row.type === "item/agentMessage/delta") {
      const data = record(row.data);
      if (!data || !isRoot(data) || typeof data.itemId !== "string") continue;
      const itemId = data.itemId;
      if (next.speakingItemId !== itemId) bumpRoot(itemId, true);
      if (typeof data.delta === "string") feedAssistantText(itemId, data.delta);
      continue;
    }

    if (row.type !== "item/started" && row.type !== "item/completed") continue;
    const item = itemFrom(row);
    if (!item || typeof item.id !== "string" || !isRoot(item)) continue;

    const assistant = item.type === "agentMessage";
    const itemId = item.id;
    const wasKnown = next.rootItemIds!.includes(itemId);
    if (!wasKnown) bumpRoot(itemId, assistant);

    if (
      row.type === "item/completed" &&
      assistant &&
      next.speakingItemId === itemId &&
      typeof item.text === "string"
    ) {
      const suffix = item.text.slice(next.emittedChars);
      feedAssistantText(itemId, suffix);
    }
  }

  next.cursorSeq = String(cursor);
  return {
    state: next,
    live:
      next.speakingItemId && liveSentences.length > 0
        ? {
            epoch: next.epoch,
            itemId: next.speakingItemId,
            sentences: liveSentences,
          }
        : null,
    invalidatePriorAudio,
    turnCompleted,
  };
}
