import * as Dialog from "@radix-ui/react-dialog";
import { ownerThread } from "@/lib/card";
import type { ExecutionSelection } from "@/lib/execution";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { taskDiagnostics, taskPresentationState, taskStage } from "./task-state";
import type { PipelineCardProps } from "./card";
import { CardActions } from "./card-actions";
import { MachineSelect } from "./machine-select";
import { Icon } from "./icon";

function executionLabel(execution: ExecutionSelection): string {
  return [
    execution.providerId,
    execution.model,
    execution.reasoningLevel,
    execution.serviceTier,
  ].filter((value) => value !== undefined).join(" · ");
}

export function TaskDetails(props: PipelineCardProps) {
  const { card } = props;
  const owner = ownerThread(card);
  const machine = props.machines.find((candidate) => candidate.id === card.hostId);
  const state = taskPresentationState(card, props);
  const diagnostics = taskDiagnostics(card, props);
  const portalScope = usePortalScopeProps();
  const threadActions = [
    owner === null ? null : { label: "Open owner thread", threadId: owner },
    card.intakeThreadId === null || card.intakeThreadId === owner
      ? null
      : { label: "Open intake thread", threadId: card.intakeThreadId },
    card.leadThreadId === null || card.leadThreadId === owner
      ? null
      : { label: "Open lead thread", threadId: card.leadThreadId },
  ].filter((action): action is { label: string; threadId: string } => action !== null);

  return (
    <Dialog.Portal>
      <Dialog.Overlay {...portalScope} className="pipeline-detail-overlay" />
      <Dialog.Content {...portalScope} className="pipeline-ui pipeline-detail-panel">
        <header className="pipeline-detail-header">
          <Dialog.Title>{card.title}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Task details, diagnostics, and controls for {card.title}
          </Dialog.Description>
          <Dialog.Close asChild>
            <button type="button" className="pipeline-icon-button" aria-label="Close task details">
              <Icon name="X" />
            </button>
          </Dialog.Close>
        </header>
        <div className="pipeline-detail-body">
          {props.actionError == null ? null : <p role="alert" className="pipeline-error">{props.actionError}</p>}
          <dl className="pipeline-detail-fields">
            <dt>Stage</dt>
            <dd>{taskStage(card)}</dd>
            <dt>Status</dt>
            <dd>{state.label}</dd>
            <dt>Machine</dt>
            <dd>
              {card.hostId === null ? (
                <MachineSelect
                  machines={props.machines}
                  value=""
                  onChange={props.onSetMachine}
                  disabled={props.pending}
                  label={`Machine for ${card.title}`}
                />
              ) : machine === undefined ? card.hostId : machine.name}
            </dd>
            {card.issueUrl === null ? null : (
              <>
                <dt>Issue</dt>
                <dd><a href={card.issueUrl} target="_blank" rel="noreferrer">Open issue <Icon name="ExternalLink" /></a></dd>
              </>
            )}
            {card.prUrl === null ? null : (
              <>
                <dt>Pull request</dt>
                <dd><a href={card.prUrl} target="_blank" rel="noreferrer">Open pull request <Icon name="ExternalLink" /></a></dd>
              </>
            )}
            {card.intake === null ? null : (
              <>
                <dt>Intake execution</dt>
                <dd>{executionLabel(card.intake)}</dd>
              </>
            )}
            {card.lead === null ? null : (
              <>
                <dt>Lead execution</dt>
                <dd>{executionLabel(card.lead)}</dd>
              </>
            )}
            {card.tier === null ? null : (
              <>
                <dt>Tier</dt>
                <dd>{card.tier}</dd>
              </>
            )}
          </dl>

          {diagnostics.length === 0 ? null : (
            <div>
              {diagnostics.map((diagnostic) => (
                <p
                  key={`${diagnostic.kind}:${diagnostic.message}`}
                  className={`pipeline-task-reason${diagnostic.kind === "error" ? " pipeline-card-error" : diagnostic.kind === "question" ? " pipeline-attention" : ""}`}
                  data-tone={diagnostic.kind === "error" ? "error" : diagnostic.kind === "question" ? "attention" : undefined}
                  aria-label={diagnostic.kind === "question" ? "Question open" : undefined}
                >
                  <Icon name={diagnostic.kind === "question" ? "MessageQuestion" : diagnostic.kind === "queue" ? "Clock" : "AlertCircle"} />
                  {diagnostic.message}
                </p>
              ))}
            </div>
          )}

          {card.body.trim() === "" ? null : (
            <p>{card.body}</p>
          )}

          {card.attachments.length === 0 ? null : (
            <section aria-label="Attachments">
              <h3>Attachments</h3>
              <ul>
                {card.attachments.map((attachment) => (
                  <li key={`${attachment.path}:${attachment.filename}`}>
                    <Icon name="Paperclip" /> {attachment.filename}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {threadActions.length === 0 ? null : (
            <div className="pipeline-detail-threads">
              {threadActions.map((action) => (
                <button key={action.label} type="button" className="pipeline-button pipeline-ghost"
                  onClick={() => props.onOpen(action.threadId)}>
                  <Icon name="ExternalLink" /> {action.label}
                </button>
              ))}
            </div>
          )}

          <CardActions {...props} />
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
