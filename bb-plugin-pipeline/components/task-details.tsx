import * as Dialog from "@radix-ui/react-dialog";
import { ownerThread } from "@/lib/card";
import type { ExecutionSelection } from "@/lib/execution";
import { usePortalScopeProps } from "@/lib/portal-scope";
import {
  GITHUB_CHECK_LABELS,
  taskDiagnostics,
  taskGithubFollowup,
  taskGithubMergeLabel,
  taskGithubRetryable,
  taskGithubReviewLabel,
  taskGithubStateLabel,
  taskGithubSyncedLabel,
  taskPresentationState,
  taskStage,
} from "./task-state";
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
  const followup = taskGithubFollowup(card);
  const reviewRetryable = taskGithubRetryable(card);
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
                  <Icon
                    name={
                      diagnostic.kind === "question" ? "MessageQuestion"
                      : diagnostic.kind === "working" ? "Loading"
                      : diagnostic.kind === "queue" ? "Clock"
                      : "AlertCircle"
                    }
                    className={diagnostic.kind === "working" ? "pipeline-spin" : ""}
                  />
                  {diagnostic.message}
                </p>
              ))}
            </div>
          )}

          {card.prUrl === null ? null : (
            <section className="pipeline-github" aria-label="GitHub pull request">
              <h3>GitHub</h3>
              {card.github === null ? <p className="pipeline-github-empty">Not synced yet</p> : (
                <dl className="pipeline-github-fields">
                  <dt>Pull request</dt>
                  <dd>{card.github.number === null ? "Not synced yet" : `#${card.github.number} · ${taskGithubStateLabel(card)}`}</dd>
                  <dt>Review</dt>
                  <dd>{taskGithubReviewLabel(card)}</dd>
                  <dt>Decision</dt>
                  <dd>{card.github.reviewDecision ?? "None"}</dd>
                  <dt>Merge</dt>
                  <dd>{taskGithubMergeLabel(card)}</dd>
                  <dt>Checks</dt>
                  <dd>
                    {card.github.checks.length === 0 ? "No checks" : (
                      <ul className="pipeline-check-list">
                        {card.github.checks.map((check) => (
                          <li key={`${check.name}:${check.url ?? ""}`} className="pipeline-check" data-state={check.state}>
                            <span className="pipeline-check-name">{check.name}</span>
                            <span className="pipeline-check-state">{GITHUB_CHECK_LABELS[check.state]}</span>
                            {check.url === null ? null : (
                              <a href={check.url} target="_blank" rel="noreferrer" aria-label={`Open ${check.name} details`}>
                                <Icon name="ExternalLink" />
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                  <dt>Synced</dt>
                  <dd>{taskGithubSyncedLabel(card)}</dd>
                  {followup === null ? null : (
                    <>
                      <dt>Follow-up</dt>
                      <dd>{followup}</dd>
                    </>
                  )}
                </dl>
              )}
              {card.github === null || card.github.error === null ? null : (
                <p className="pipeline-task-reason pipeline-card-error" data-tone="error">
                  <Icon name="AlertCircle" />
                  GitHub sync failed: {card.github.error}
                </p>
              )}
              <div className="pipeline-github-actions">
                <button
                  type="button"
                  className="pipeline-button pipeline-ghost"
                  disabled={props.pending}
                  onClick={props.onSyncGithub}
                >
                  <Icon name="RotateCcw" /> Refresh GitHub
                </button>
                {reviewRetryable ? (
                  <button
                    type="button"
                    className="pipeline-button pipeline-ghost"
                    disabled={props.pending}
                    onClick={props.onRetryReview}
                  >
                    <Icon name="RotateCcw" /> {card.github?.manualReviewPending ? "Send to lead" : "Retry review"}
                  </button>
                ) : null}
              </div>
            </section>
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
