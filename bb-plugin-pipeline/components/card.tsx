import { useRef, useState, type DragEventHandler } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { ownerThread } from "@/lib/card";
import type { PipelineMachine } from "@/lib/machines";
import { usePortalScopeProps } from "@/lib/portal-scope";
import type { CardActionProps } from "./card-actions";
import { CardActions, StartTaskButton } from "./card-actions";
import { Icon } from "./icon";
import { MachineSelect } from "./machine-select";
import { TaskDetails } from "./task-details";
import {
  taskGithubSummary,
  taskPresentationState,
  taskPrimaryReason,
  taskQuestionOpen,
  taskStage,
} from "./task-state";

export interface PipelineCardProps extends CardActionProps {
  layout: "list" | "board";
  actionError?: string | null;
  machines: PipelineMachine[];
  onSetMachine(hostId: string): void;
  questionOpen: boolean;
  dragging: boolean;
  onDragStart: DragEventHandler<HTMLElement>;
  onDragEnd(): void;
  onOpen(threadId: string): void;
}

function stateClass(kind: ReturnType<typeof taskPresentationState>["kind"]): string {
  if (kind === "saving" || kind === "working") return "pipeline-working";
  if (kind === "queued") return "pipeline-queued";
  if (kind === "held") return "pipeline-run-state";
  if (kind === "attention") return "pipeline-attention";
  return "";
}

export function PipelineCard(props: PipelineCardProps) {
  const { card } = props;
  const owner = ownerThread(card);
  const running = card.runState === "running";
  const dragAllowed = useRef(true);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const portalScope = usePortalScopeProps();
  const state = taskPresentationState(card, props);
  const reason = taskPrimaryReason(card, props);
  const github = taskGithubSummary(card);
  const questionOpen = taskQuestionOpen(card, props.questionOpen);
  const machineName = props.machines.find((machine) => machine.id === card.hostId)?.name ?? card.hostId;

  return (
    <Dialog.Root open={detailsOpen} onOpenChange={setDetailsOpen}>
      <article
        aria-label={card.title}
        aria-busy={props.pending}
        draggable={props.layout === "board" && running && card.startRequested && !props.pending}
        data-dragging={props.dragging}
        onPointerDownCapture={(event) => {
          dragAllowed.current = !(event.target as Element).closest("[data-card-control]");
        }}
        onDragStart={(event) => {
          if (props.layout !== "board" || !dragAllowed.current) {
            event.preventDefault();
            return;
          }
          setActionsOpen(false);
          props.onDragStart(event);
        }}
        onDragEnd={props.onDragEnd}
        className={`pipeline-card${props.layout === "list" ? " pipeline-task-row" : ""}`}
      >
        <div className="pipeline-task-main">
          <button
            type="button"
            className="pipeline-card-title"
            onClick={() => owner === null ? setDetailsOpen(true) : props.onOpen(owner)}
          >
            {card.title}
          </button>
          {reason === null ? null : (
            <div
              className="pipeline-task-reason"
              data-tone={reason.kind === "error" ? "error" : reason.kind === "question" ? "attention" : undefined}
            >
              {reason.message}
            </div>
          )}
          {github === null ? null : (
            <span className="pipeline-github-chip" data-tone={github.tone}>{github.label}</span>
          )}
          {questionOpen ? <span className="sr-only" aria-label="Question open">Question open</span> : null}
          <StartTaskButton card={card} pending={props.pending} onStart={props.onStart} />
        </div>

        <span className="pipeline-task-stage" data-stage={card.column}>
          <span className="pipeline-stage" data-stage={card.column} aria-hidden="true" />
          {taskStage(card)}
        </span>

        <span
          className={`pipeline-task-state ${stateClass(state.kind)}`}
          data-state={state.kind}
        >
          {state.kind === "saving" ? <Icon name="Loading" className="pipeline-spin" /> : null}
          {state.label}
        </span>

        <div className="pipeline-task-machine" data-card-control>
          {card.hostId === null ? (
            <MachineSelect
              machines={props.machines}
              value=""
              onChange={props.onSetMachine}
              disabled={props.pending}
              label={`Machine for ${card.title}`}
            />
          ) : (
            <span className="pipeline-machine" title={`Machine: ${machineName}`}>
              <Icon name="Laptop" />
              <span className="pipeline-machine-name">{machineName}</span>
            </span>
          )}
        </div>

        <div className="pipeline-task-actions" data-card-control>
          <Dialog.Trigger asChild>
            <button
              type="button"
              className="pipeline-icon-button"
              aria-label={`Details for ${card.title}`}
              title="Task details"
            >
              <Icon name="ChevronRight" />
            </button>
          </Dialog.Trigger>
          <Popover.Root open={actionsOpen} onOpenChange={setActionsOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="pipeline-icon-button"
                aria-label={`Actions for ${card.title}`}
                title="Task actions"
                disabled={props.pending}
              >
                <Icon name="MoreHorizontal" />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                {...portalScope}
                className="pipeline-ui pipeline-popover"
                align="end"
                sideOffset={6}
                aria-label={`Actions for ${card.title}`}
              >
                <CardActions {...props} onAction={() => setActionsOpen(false)} />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </article>
      <TaskDetails {...props} />
    </Dialog.Root>
  );
}
