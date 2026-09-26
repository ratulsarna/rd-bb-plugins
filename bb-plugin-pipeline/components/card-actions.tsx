import { COLUMNS, COLUMN_LABELS, type Column } from "@/lib/columns";
import type { Card } from "@/lib/store";
import type { TaskQueueState } from "./task-state";
import { Icon } from "./icon";

export interface CardActionProps {
  card: Card;
  pending: boolean;
  queue: TaskQueueState | null;
  occupied?: boolean;
  onStart(): void;
  onMove(column: Column): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onSetRunNext(enabled: boolean): void;
  onRetry(): void;
  onRemove(): void;
  onSyncGithub(): void;
  onSyncIssue(): void;
  onRetryReview(): void;
}

function run(action: () => void, onAction?: () => void): void {
  onAction?.();
  action();
}

export function StartTaskButton(props: Pick<CardActionProps, "card" | "pending" | "onStart">) {
  if (
    props.card.startRequested ||
    props.card.column === "done" ||
    props.card.runState !== "running"
  ) {
    return null;
  }

  return (
    <button
      type="button"
      data-card-control
      className="pipeline-button pipeline-start"
      disabled={props.pending}
      onClick={props.onStart}
    >
      <Icon name="Play" /> Start
    </button>
  );
}

export function CardActions(
  props: CardActionProps & { onAction?: () => void },
) {
  const { card } = props;
  const running = card.runState === "running";
  const doneOccupied = card.column === "done" && props.occupied === true;
  const lifecycleVisible = (card.startRequested && card.column !== "done") || doneOccupied;

  return (
    <div className="pipeline-card-actions" data-card-control>
      <StartTaskButton card={card} pending={props.pending}
        onStart={() => run(props.onStart, props.onAction)} />
      {lifecycleVisible ? (
        <div className="pipeline-card-controls">
          {doneOccupied ? (
            <button type="button" className="pipeline-button pipeline-ghost pipeline-stop" disabled={props.pending}
              onClick={() => run(props.onStop, props.onAction)}>
              <Icon name="Square" /> Stop now
            </button>
          ) : (
            <>
              {card.runState === "running" ? (
            <button type="button" className="pipeline-button pipeline-ghost" disabled={props.pending}
              onClick={() => run(props.onPause, props.onAction)}>
              <Icon name="Pause" /> Pause
            </button>
          ) : card.runState === "paused" ? (
            <button type="button" className="pipeline-button pipeline-ghost" disabled={props.pending}
              onClick={() => run(props.onResume, props.onAction)}>
              <Icon name="Play" /> Resume
            </button>
          ) : (
            <>
              {card.runState === "pause_requested" && card.controlError !== null ? (
                <button type="button" className="pipeline-button pipeline-ghost" disabled={props.pending}
                  onClick={() => run(props.onPause, props.onAction)}>
                  <Icon name="RotateCcw" /> Retry pause
                </button>
              ) : null}
              <button type="button" className="pipeline-button pipeline-ghost pipeline-stop" disabled={props.pending}
                onClick={() => run(props.onStop, props.onAction)}>
                <Icon name="Square" /> Stop now
              </button>
            </>
          )}
          {running && card.launchError !== null ? (
            <button type="button" className="pipeline-button pipeline-ghost pipeline-retry" disabled={props.pending}
              onClick={() => run(props.onRetry, props.onAction)}>
              <Icon name="RotateCcw" /> Retry
            </button>
          ) : null}
          {props.queue?.next ? (
            <button type="button" className="pipeline-button pipeline-ghost" disabled={props.pending}
              onClick={() => run(() => props.onSetRunNext(false), props.onAction)}>
              <Icon name="X" /> Clear run next
            </button>
          ) : props.queue?.canRunNext ? (
            <button type="button" className="pipeline-button pipeline-ghost" disabled={props.pending}
              onClick={() => run(() => props.onSetRunNext(true), props.onAction)}>
              <Icon name="Play" /> Run next
            </button>
          ) : null}
            </>
          )}
        </div>
      ) : null}
      <label className="pipeline-field">
        <span className="pipeline-field-label">Move to</span>
        <span className="pipeline-select-wrap">
          <select
            aria-label={`Move ${card.title}`}
            className="pipeline-select"
            value={card.column}
            disabled={props.pending || !running || !card.startRequested}
            onChange={(event) => {
              props.onMove(event.target.value as Column);
              props.onAction?.();
            }}
          >
            {COLUMNS.filter((column) => column !== "backlog" || !card.startRequested).map((column) => (
              <option key={column} value={column}>{COLUMN_LABELS[column]}</option>
            ))}
          </select>
          <Icon name="ChevronDown" />
        </span>
      </label>
      <button
        type="button"
        className="pipeline-button pipeline-ghost pipeline-remove"
        disabled={props.pending || !running}
        onClick={() => run(props.onRemove, props.onAction)}
      >
        <Icon name="Trash2" /> Remove
      </button>
    </div>
  );
}
