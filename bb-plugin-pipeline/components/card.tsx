import type { MouseEvent } from "react";
import { COLUMNS, COLUMN_LABELS, type Column } from "@/lib/columns";
import type { Card } from "@/lib/store";

function attention(card: Card): string | null {
  if (card.needsUser) return card.attentionReason ?? "needs you";
  if (card.attentionUnknown) return "idle, unchecked";
  if (card.threadError !== null) return `thread failed: ${card.threadError}`;
  if (card.launchError !== null) return `launch failed: ${card.launchError}`;
  return null;
}

export function PipelineCard(props: {
  card: Card;
  questionOpen: boolean;
  onOpen(threadId: string): void;
  onMove(column: Column): void;
  onRetry(): void;
  onRemove(): void;
}) {
  const owner = props.card.leadThreadId ?? props.card.intakeThreadId;
  const stop = (event: MouseEvent) => event.stopPropagation();
  return (
    <article className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <button
        type="button"
        className="block w-full text-left disabled:cursor-default"
        disabled={owner === null}
        onClick={() => owner !== null && props.onOpen(owner)}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="font-medium leading-snug">{props.card.title}</span>
          {props.card.tier === null ? null : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {props.card.tier}
            </span>
          )}
        </span>
        {attention(props.card) === null ? null : (
          <span className="mt-2 block text-xs text-amber-700 dark:text-amber-300">
            {attention(props.card)}
          </span>
        )}
        {props.questionOpen ? (
          <span aria-label="Question open" title="Question open" className="mt-1 block text-sm font-semibold">
            ?
          </span>
        ) : null}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" onClick={stop}>
        {props.card.issueUrl === null ? null : (
          <a className="text-primary underline" href={props.card.issueUrl} target="_blank" rel="noreferrer">
            Issue
          </a>
        )}
        {props.card.prUrl === null ? null : (
          <a className="text-primary underline" href={props.card.prUrl} target="_blank" rel="noreferrer">
            PR
          </a>
        )}
        <label className="ml-auto">
          <span className="sr-only">Move {props.card.title}</span>
          <select
            aria-label={`Move ${props.card.title}`}
            className="rounded border border-input bg-background px-1.5 py-1"
            value={props.card.column}
            onChange={(event) => props.onMove(event.target.value as Column)}
          >
            {COLUMNS.map((column) => (
              <option key={column} value={column}>
                {COLUMN_LABELS[column]}
              </option>
            ))}
          </select>
        </label>
        {props.card.launchError === null ? null : (
          <button
            type="button"
            className="inline-flex h-7 items-center justify-center rounded-md border border-input bg-background px-2 text-xs hover:bg-accent hover:text-accent-foreground"
            onClick={props.onRetry}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          className="inline-flex h-7 items-center justify-center rounded-md px-2 text-xs hover:bg-accent hover:text-accent-foreground"
          onClick={props.onRemove}
        >
          Remove
        </button>
      </div>
    </article>
  );
}
