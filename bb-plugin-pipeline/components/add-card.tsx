import { useState } from "react";
import type { FormEvent } from "react";
import type { PipelineMachine } from "@/lib/machines";
import { MachineSelect } from "./machine-select";

export function AddCard(props: {
  disabled: boolean;
  machines: PipelineMachine[];
  onAdd(title: string, body: string, files: File[], hostId: string): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [hostId, setHostId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedHostId = props.machines.some((machine) => machine.id === hostId) ? hostId : "";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim() === "" || selectedHostId === "" || props.disabled || pending) return;
    if (files.length > 20) {
      setError("Choose at most 20 attachments.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await props.onAdd(title.trim(), body, files, selectedHostId);
      setTitle("");
      setBody("");
      setFiles([]);
      setHostId("");
      setError(null);
      setOpen(false);
    } catch {
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        disabled={props.disabled}
        onClick={() => {
          setHostId("");
          setOpen(true);
        }}
      >
        Add card
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-border bg-card p-3">
      <MachineSelect
        machines={props.machines}
        value={selectedHostId}
        onChange={setHostId}
        disabled={pending || props.disabled}
      />
      {props.machines.length === 0 ? (
        <p className="text-xs text-muted-foreground">This project has no machine with a checkout.</p>
      ) : null}
      <input
        aria-label="Card title"
        placeholder="Card title"
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        aria-label="Card note"
        placeholder="What do you know so far?"
        className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <input
        aria-label="Card attachments"
        type="file"
        multiple
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        onChange={(event) => {
          const next = Array.from(event.target.files ?? []);
          setFiles(next);
          setError(next.length > 20 ? "Choose at most 20 attachments." : null);
        }}
      />
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          disabled={props.disabled || pending || title.trim() === "" || selectedHostId === ""}
        >
          {pending ? "Adding…" : "Add"}
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
