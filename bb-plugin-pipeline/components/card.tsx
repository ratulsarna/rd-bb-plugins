import { useRef, useState, type DragEventHandler } from "react";
import * as Popover from "@radix-ui/react-popover";
import { COLUMNS, COLUMN_LABELS, type Column } from "@/lib/columns";
import { ownerThread, type Card } from "@/lib/store";
import type { PipelineMachine } from "@/lib/machines";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { MachineSelect } from "./machine-select";
import { Icon } from "./icon";

function attention(card: Card): string | null {
  if (card.needsUser) return card.attentionReason ?? "Needs your input";
  if (card.threadError !== null) return `Thread failed: ${card.threadError}`;
  if (card.attentionUnknown) return "Idle · awaiting status";
  return null;
}

export function PipelineCard(props: {
  card: Card;
  machines: PipelineMachine[];
  onSetMachine(hostId: string): void;
  questionOpen: boolean;
  dragging: boolean;
  pending: boolean;
  queued: boolean;
  onDragStart: DragEventHandler<HTMLElement>;
  onDragEnd(): void;
  onOpen(threadId: string): void;
  onMove(column: Column): void;
  onRetry(): void;
  onRemove(): void;
}) {
  const { card } = props;
  const owner = ownerThread(card);
  const dragAllowed = useRef(true);
  const [actionsOpen, setActionsOpen] = useState(false);
  const portalScope = usePortalScopeProps();
  const reason = attention(card);
  const machineName = props.machines.find((machine) => machine.id === card.hostId)?.name ?? card.hostId;

  return (
    <article
      aria-label={card.title}
      aria-busy={props.pending}
      draggable={!props.pending}
      data-dragging={props.dragging}
      onPointerDownCapture={(event) => {
        dragAllowed.current = !(event.target as Element).closest("[data-card-control]");
      }}
      onDragStart={(event) => {
        if (!dragAllowed.current) {
          event.preventDefault();
          return;
        }
        setActionsOpen(false);
        props.onDragStart(event);
      }}
      onDragEnd={props.onDragEnd}
      className="pipeline-card"
    >
      <div className="pipeline-card-header">
        <button type="button" className="pipeline-card-title" disabled={owner === null}
          onClick={() => owner !== null && props.onOpen(owner)}>
          {card.title}
        </button>
        <Popover.Root open={actionsOpen} onOpenChange={setActionsOpen}>
          <Popover.Trigger asChild>
            <button type="button" data-card-control className="pipeline-icon-button" aria-label={`Actions for ${card.title}`}
              title="Task actions" disabled={props.pending}>
              <Icon name="MoreHorizontal" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content {...portalScope} data-card-control className="pipeline-ui pipeline-popover" align="end" sideOffset={6}
              aria-label={`Actions for ${card.title}`}>
              <label className="pipeline-field">
                <span className="pipeline-field-label">Move to</span>
                <span className="pipeline-select-wrap">
                  <select aria-label={`Move ${card.title}`} className="pipeline-select" value={card.column} disabled={props.pending}
                    onChange={(event) => {
                      props.onMove(event.target.value as Column);
                      setActionsOpen(false);
                    }}>
                    {COLUMNS.map((column) => <option key={column} value={column}>{COLUMN_LABELS[column]}</option>)}
                  </select>
                  <Icon name="ChevronDown" />
                </span>
              </label>
              <button type="button" className="pipeline-button pipeline-ghost pipeline-remove" disabled={props.pending}
                onClick={() => {
                  setActionsOpen(false);
                  props.onRemove();
                }}>
                <Icon name="Trash2" /> Remove
              </button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {card.body.trim() === "" ? null : <p className="pipeline-card-note">{card.body}</p>}
      {reason === null ? null : (
        <div className="pipeline-card-status pipeline-attention"><Icon name="AlertCircle" /><span>{reason}</span></div>
      )}
      {props.questionOpen ? (
        <div aria-label="Question open" className="pipeline-card-status pipeline-attention">
          <Icon name="MessageQuestion" /><span>Question waiting for you</span>
        </div>
      ) : null}
      {card.launchError === null ? null : (
        <div className="pipeline-card-status pipeline-card-error" data-card-control>
          <Icon name="AlertCircle" />
          <div>
            <p>Launch failed: {card.launchError}</p>
            <button type="button" className="pipeline-retry" disabled={props.pending} onClick={props.onRetry}>
              <Icon name="RotateCcw" /> Retry
            </button>
          </div>
        </div>
      )}
      {card.issueUrl === null && card.prUrl === null && card.attachments.length === 0 ? null : (
        <div className="pipeline-card-links" data-card-control>
          {card.issueUrl === null ? null : (
            <a href={card.issueUrl} target="_blank" rel="noreferrer"><Icon name="ExternalLink" />Issue</a>
          )}
          {card.prUrl === null ? null : (
            <a href={card.prUrl} target="_blank" rel="noreferrer"><Icon name="GitPullRequest" />PR</a>
          )}
          {card.attachments.length === 0 ? null : (
            <span title={`${card.attachments.length} attachments`}><Icon name="Paperclip" /> {card.attachments.length}</span>
          )}
        </div>
      )}
      <div className="pipeline-card-footer" data-card-control>
        {card.hostId === null ? (
          <MachineSelect machines={props.machines} value="" onChange={props.onSetMachine} disabled={props.pending} label={`Machine for ${card.title}`} />
        ) : (
          <span className="pipeline-machine" title={`Machine: ${machineName}`}>
            <Icon name="Laptop" /><span className="pipeline-machine-name">{machineName}</span>
          </span>
        )}
        {props.pending ? <span className="pipeline-working"><Icon name="Loading" className="pipeline-spin" /> Saving</span>
          : props.queued ? <span className="pipeline-queued">Queued</span>
          : card.reportSignal === "working" && !card.needsUser && !card.attentionUnknown && !props.questionOpen && card.threadError === null && card.launchError === null
            ? <span className="pipeline-working">Working</span> : null}
        {card.tier === null ? null : <span className="pipeline-tier">{card.tier}</span>}
      </div>
    </article>
  );
}
