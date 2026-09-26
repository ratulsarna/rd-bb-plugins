import { useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { ExecutionDefaults, ExecutionSelection } from "@/lib/execution";
import type { PipelineMachine } from "@/lib/machines";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { ExecutionFields } from "./execution-fields";
import { Icon } from "./icon";

export function AddCard(props: {
  disabled: boolean;
  projectName: string;
  machines: PipelineMachine[];
  loadExecutionDefaults(): Promise<ExecutionDefaults>;
  onAdd(
    title: string,
    body: string,
    files: File[],
    hostId: string,
    intake: ExecutionSelection,
    lead: ExecutionSelection,
    start: boolean,
  ): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [hostId, setHostId] = useState("");
  const [intake, setIntake] = useState<ExecutionSelection | null>(null);
  const [lead, setLead] = useState<ExecutionSelection | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<"save" | "start">("save");
  const [error, setError] = useState<string | null>(null);
  const defaultsRequest = useRef(0);
  const portalScope = usePortalScopeProps();
  const formError = files.length > 20 ? "Choose at most 20 attachments." : error;
  const selectedHostId = props.machines.some((machine) => machine.id === hostId) ? hostId : "";
  const executionReady = intake !== null && lead !== null;
  const submitBlocked = props.disabled || pending || title.trim() === "" || selectedHostId === "" || !executionReady || files.length > 20;

  useEffect(() => () => {
    defaultsRequest.current += 1;
  }, []);

  function loadDefaults() {
    const request = ++defaultsRequest.current;
    setIntake(null);
    setLead(null);
    void props.loadExecutionDefaults().then(
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
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim() === "" || selectedHostId === "" || !executionReady || props.disabled || pending) return;
    if (files.length > 20) return;
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const intent = submitter instanceof HTMLButtonElement && submitter.dataset.intent === "start" ? "start" : "save";
    setPending(true);
    setPendingIntent(intent);
    setError(null);
    try {
      await props.onAdd(title.trim(), body, files, selectedHostId, intake, lead, intent === "start");
      setTitle("");
      setBody("");
      setFiles([]);
      setHostId("");
      setIntake(null);
      setLead(null);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      if (pending) return;
      if (next) {
        setHostId("");
        setError(null);
        loadDefaults();
      } else {
        defaultsRequest.current += 1;
      }
      setOpen(next);
    }}>
      <Dialog.Trigger asChild>
        <button type="button" className="pipeline-button pipeline-primary" disabled={props.disabled}>
          <Icon name="Plus" /> New task
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <div {...portalScope} className="pipeline-ui pipeline-overlay-scope">
          <Dialog.Overlay className="pipeline-dialog-overlay" />
          <Dialog.Content className="pipeline-dialog" onInteractOutside={(event) => event.preventDefault()}>
            <div className="pipeline-dialog-header">
              <div className="pipeline-dialog-heading">
                <Dialog.Title>New task</Dialog.Title>
                <Dialog.Description className="sr-only">New task for {props.projectName}</Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="pipeline-icon-button" aria-label="Close new task" disabled={pending}>
                  <Icon name="X" />
                </button>
              </Dialog.Close>
            </div>
            <form onSubmit={submit} className="pipeline-form" aria-busy={pending}>
              <label className="pipeline-field">
                <span className="pipeline-field-label">Task title</span>
                <input
                  aria-label="Task title"
                  placeholder="What needs to be done?"
                  className="pipeline-input"
                  value={title}
                  disabled={pending}
                  autoFocus
                  required
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="pipeline-field">
                <span className="pipeline-field-label">Context <span>optional</span></span>
                <textarea
                  aria-label="Task context"
                  placeholder="Context, notes, or links"
                  className="pipeline-input"
                  value={body}
                  disabled={pending}
                  onChange={(event) => setBody(event.target.value)}
                />
              </label>
              <ExecutionFields
                machines={props.machines}
                hostId={hostId}
                onHostChange={setHostId}
                intake={intake}
                lead={lead}
                onIntakeChange={setIntake}
                onLeadChange={setLead}
                disabled={pending || props.disabled}
              />
              <label className="pipeline-attach">
                <Icon name="Paperclip" /> Attach files or screenshots
                <input
                  aria-label="Task attachments"
                  type="file"
                  multiple
                  className="sr-only"
                  disabled={pending}
                  onChange={(event) => {
                    const next = [...files, ...Array.from(event.target.files ?? [])];
                    setFiles(next);
                    event.target.value = "";
                  }}
                />
              </label>
              {files.length === 0 ? null : (
                <ul className="pipeline-file-list" aria-label="Attached files">
                  {files.map((file, index) => (
                    <li key={`${index}-${file.name}`}>
                      <Icon name="Paperclip" /><span title={file.name}>{file.name}</span>
                      <button type="button" className="pipeline-icon-button" aria-label={`Remove ${file.name}`} disabled={pending}
                        onClick={() => setFiles((current) => current.filter((_, position) => position !== index))}>
                        <Icon name="X" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {formError === null ? null : <p role="alert" className="pipeline-error"><Icon name="AlertCircle" />{formError}</p>}
              <div className="pipeline-form-footer">
                <Dialog.Close asChild>
                  <button type="button" className="pipeline-button pipeline-ghost" disabled={pending}>Cancel</button>
                </Dialog.Close>
                <button type="submit" data-intent="save" className="pipeline-button pipeline-primary" disabled={submitBlocked}>
                  <Icon name={pendingIntent === "save" && pending ? "Loading" : "Plus"} className={pendingIntent === "save" && pending ? "pipeline-spin" : ""} />
                  Save
                </button>
                <button type="submit" data-intent="start" className="pipeline-button" disabled={submitBlocked}>
                  <Icon name={pendingIntent === "start" && pending ? "Loading" : "Play"} className={pendingIntent === "start" && pending ? "pipeline-spin" : ""} />
                  Save and start
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
