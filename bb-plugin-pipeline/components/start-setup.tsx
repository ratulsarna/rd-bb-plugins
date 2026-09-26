import { useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { ExecutionDefaults, ExecutionSelection } from "@/lib/execution";
import type { PipelineMachine } from "@/lib/machines";
import type { Card } from "@/lib/store";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { ExecutionFields } from "./execution-fields";
import { Icon } from "./icon";

/**
 * Setup dialog shown when an imported task starts without machine or
 * execution configuration. Nothing is sent until the user confirms; a
 * failure keeps the dialog open with the selections intact.
 */
export function StartSetup(props: {
  card: Card;
  machines: PipelineMachine[];
  loadExecutionDefaults(): Promise<ExecutionDefaults>;
  onStart(input: { cardId: string; hostId: string; intake: ExecutionSelection; lead: ExecutionSelection }): Promise<void>;
  onOpenChange(open: boolean): void;
}) {
  const [hostId, setHostId] = useState(props.card.hostId ?? "");
  const [intake, setIntake] = useState<ExecutionSelection | null>(null);
  const [lead, setLead] = useState<ExecutionSelection | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultsRequest = useRef(0);
  const loadDefaultsRef = useRef(props.loadExecutionDefaults);
  loadDefaultsRef.current = props.loadExecutionDefaults;
  const portalScope = usePortalScopeProps();
  const selectedHostId = props.machines.some((machine) => machine.id === hostId) ? hostId : "";
  const executionReady = intake !== null && lead !== null;
  const issue = props.card.importedIssue;
  const submitBlocked = pending || selectedHostId === "" || !executionReady;

  useEffect(() => {
    const request = ++defaultsRequest.current;
    void loadDefaultsRef.current().then(
      (defaults) => {
        if (request !== defaultsRequest.current) return;
        setIntake(defaults.intake);
        setLead(defaults.lead);
      },
      (cause) => {
        if (request !== defaultsRequest.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      defaultsRequest.current += 1;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitBlocked) return;
    setPending(true);
    setError(null);
    try {
      await props.onStart({
        cardId: props.card.id,
        hostId: selectedHostId,
        intake: intake!,
        lead: lead!,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => {
      // Match the disabled Cancel: an in-flight start cannot be dismissed.
      if (!open && pending) return;
      props.onOpenChange(open);
    }}>
      <Dialog.Portal>
        <div {...portalScope} className="pipeline-ui pipeline-overlay-scope">
          <Dialog.Overlay className="pipeline-dialog-overlay" />
          <Dialog.Content className="pipeline-dialog" onInteractOutside={(event) => event.preventDefault()}>
            <div className="pipeline-dialog-header">
              <div className="pipeline-dialog-heading">
                <Dialog.Title>Set up task</Dialog.Title>
                <Dialog.Description className="sr-only">
                  Choose the machine and execution for {props.card.title}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="pipeline-icon-button" aria-label="Close task setup" disabled={pending}>
                  <Icon name="X" />
                </button>
              </Dialog.Close>
            </div>
            <form onSubmit={submit} className="pipeline-form" aria-busy={pending}>
              {issue === null ? null : (
                <p className="pipeline-setup-issue">
                  <span className="pipeline-import-number">#{issue.number}</span>
                  <a href={issue.url} target="_blank" rel="noreferrer">
                    {issue.title} <Icon name="ExternalLink" />
                  </a>
                </p>
              )}
              <ExecutionFields
                machines={props.machines}
                hostId={hostId}
                onHostChange={setHostId}
                intake={intake}
                lead={lead}
                onIntakeChange={setIntake}
                onLeadChange={setLead}
                disabled={pending}
              />
              {selectedHostId !== "" && !executionReady && error === null ? (
                <p className="pipeline-field-hint" role="status">Loading saved execution choices…</p>
              ) : null}
              {error === null ? null : (
                <p role="alert" className="pipeline-error"><Icon name="AlertCircle" />{error}</p>
              )}
              <div className="pipeline-form-footer">
                <Dialog.Close asChild>
                  <button type="button" className="pipeline-button pipeline-ghost" disabled={pending}>Cancel</button>
                </Dialog.Close>
                <button type="submit" className="pipeline-button pipeline-primary" disabled={submitBlocked}>
                  <Icon name={pending ? "Loading" : "Play"} className={pending ? "pipeline-spin" : ""} />
                  Start task
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
