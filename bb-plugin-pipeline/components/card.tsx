import { useRef, type DragEventHandler, type MouseEvent } from "react";
import { COLUMNS, COLUMN_LABELS, type Column } from "@/lib/columns";
import { ownerThread, type Card } from "@/lib/store";
import type { PipelineMachine } from "@/lib/machines";
import { MachineSelect } from "./machine-select";

function attention(card: Card): string | null {
  if (card.needsUser) return card.attentionReason ?? "needs you";
  if (card.attentionUnknown) return "idle, unchecked";
  if (card.threadError !== null) return `thread failed: ${card.threadError}`;
  return null;
}

export function PipelineCard(props: {
  card: Card;
  machines: PipelineMachine[];
  onSetMachine(hostId: string): void;
  questionOpen: boolean;
  dragging: boolean;
  pending: boolean;
  onDragStart: DragEventHandler<HTMLElement>;
  onDragEnd(): void;
  onOpen(threadId: string): void;
  onMove(column: Column): void;
  onRetry(): void;
  onRemove(): void;
}) {
  const owner = ownerThread(props.card);
  const actionsRef = useRef<HTMLDivElement>(null);
  const dragAllowed = useRef(true);
  const stop = (event: MouseEvent) => event.stopPropagation();
  return (
    <article
      aria-label={props.card.title}
      aria-busy={props.pending}
      draggable={!props.pending}
      onPointerDownCapture={(event) => {
        dragAllowed.current = !actionsRef.current?.contains(event.target as Node);
      }}
      onDragStart={(event) => {
        if (!dragAllowed.current) {
          event.preventDefault();
          return;
        }
        props.onDragStart(event);
      }}
      onDragEnd={props.onDragEnd}
      className={`rounded-lg border border-border bg-card p-3 shadow-sm ${props.pending ? "cursor-wait" : "cursor-grab active:cursor-grabbing"} ${props.dragging ? "opacity-50" : ""}`}
    >
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
        {props.card.launchError === null ? null : (
          <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
            launch failed: {props.card.launchError}
          </span>
        )}
        {props.questionOpen ? (
          <span aria-label="Question open" title="Question open" className="mt-1 block text-sm font-semibold">
            ?
          </span>
        ) : null}
      </button>
      <div
        ref={actionsRef}
        className="mt-2 flex flex-wrap items-center gap-2 text-xs"
        onClick={stop}
      >
        {props.card.hostId === null ? (
          <MachineSelect
            machines={props.machines}
            value=""
            onChange={props.onSetMachine}
            disabled={props.pending}
            label={`Machine for ${props.card.title}`}
          />
        ) : (
          <span className="w-full text-muted-foreground" title={props.card.hostId}>
            Machine: {props.machines.find((machine) => machine.id === props.card.hostId)?.name ?? props.card.hostId}
          </span>
        )}
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
            disabled={props.pending}
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
            disabled={props.pending}
            onClick={props.onRetry}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          className="inline-flex h-7 items-center justify-center rounded-md px-2 text-xs hover:bg-accent hover:text-accent-foreground"
          disabled={props.pending}
          onClick={props.onRemove}
        >
          Remove
        </button>
      </div>
    </article>
  );
}
