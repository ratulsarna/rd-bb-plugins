import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AddCard(props: {
  disabled: boolean;
  onAdd(title: string, body: string, files: File[]): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim() === "" || pending) return;
    setPending(true);
    try {
      await props.onAdd(title.trim(), body, files);
      setTitle("");
      setBody("");
      setFiles([]);
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" disabled={props.disabled} onClick={() => setOpen(true)}>
        Add card
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-border bg-card p-3">
      <Input
        aria-label="Card title"
        placeholder="Card title"
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
      <Input
        aria-label="Card attachments"
        type="file"
        multiple
        onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || title.trim() === ""}>
          {pending ? "Adding…" : "Add"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
