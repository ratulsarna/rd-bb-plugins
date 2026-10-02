import { useCallback, useEffect, useRef, useState } from "react";
import { PipelineSelect } from "./select";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../lib/contract";
import { INSTRUCTION_FIELDS, validateInstructionFields } from "../lib/prompt-template";
import { applyInstructionEdit } from "../lib/instruction-edit";
import {
  INSTRUCTIONS_CHANGED, instructionContentSchema,
  type InstructionId, type InstructionDocument, type InstructionSummary,
} from "../lib/instruction-types";

const GROUPS = [
  ["phases", "Phases"], ["templates", "Role templates"], ["kickoff", "Task kickoff"], ["guidelines", "Guidelines"],
] as const;
type Draft = { content: string; baseRevision: string; reset: boolean };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function InstructionSettings({ guidelinesFile = "" }: { guidelinesFile?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [catalogue, setCatalogue] = useState<InstructionSummary[]>([]);
  const [selected, setSelected] = useState<InstructionId>("README.md");
  const [documents, setDocuments] = useState<Partial<Record<InstructionId, InstructionDocument>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<InstructionId, Draft>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const sequence = useRef(0);
  const saving = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (saving.current) return;
    const request = ++sequence.current;
    try {
      const [list, document] = await Promise.all([
        rpc.call("listInstructions", null), rpc.call("readInstruction", { id: selected }),
      ]);
      if (!alive.current || request !== sequence.current) return;
      setCatalogue(list.documents);
      setDocuments((current) => ({ ...current, [selected]: document }));
      setError(null);
    } catch (cause) {
      if (alive.current && request === sequence.current) setError(message(cause));
    }
  }, [rpc, selected]);

  useEffect(() => {
    alive.current = true;
    setNotice("");
    void refresh();
    return () => { alive.current = false; sequence.current += 1; };
  }, [refresh]);
  useRealtime(INSTRUCTIONS_CHANGED, refresh);

  const document = documents[selected];
  const draft = drafts[selected];
  const content = draft?.content ?? document?.content ?? "";
  const conflict = draft !== undefined && document !== undefined && draft.baseRevision !== document.revision;
  const validation = instructionContentSchema.safeParse(content);
  let fieldError: string | null = null;
  try { validateInstructionFields(selected, content); } catch (cause) { fieldError = message(cause); }
  const shownError = saveError ?? error;
  const externalGuidelines = selected === "guidelines/README.md" && guidelinesFile.trim() !== "";

  function edit(value: string) {
    if (!document) return;
    setDrafts((current) => {
      const next = { ...current };
      if (value === document.content) delete next[selected];
      else next[selected] = { content: value, baseRevision: current[selected]?.baseRevision ?? document.revision, reset: false };
      return next;
    });
    setNotice(""); setSaveError(null);
  }

  function discard() {
    setDrafts((current) => { const next = { ...current }; delete next[selected]; return next; });
    setError(null); setSaveError(null); setNotice("");
  }

  async function save() {
    if (!document || !draft || conflict || !validation.success || fieldError || saving.current) return;
    saving.current = true;
    sequence.current += 1;
    setPending(true); setError(null); setSaveError(null); setNotice("");
    try {
      const input = { id: selected, expectedRevision: draft.baseRevision };
      const result = draft.reset
        ? await rpc.call("resetInstruction", input)
        : await rpc.call("saveInstruction", { ...input, content: draft.content });
      if (!alive.current) return;
      setDocuments((current) => ({ ...current, [selected]: result }));
      setDrafts((current) => { const next = { ...current }; delete next[selected]; return next; });
      setNotice(draft.reset ? "Shipped default restored" : "Instructions saved");
    } catch (cause) {
      if (alive.current) setSaveError(message(cause));
    } finally {
      saving.current = false;
      if (alive.current) { setPending(false); void refresh(); }
    }
  }

  return <section className="pipeline-settings-section pipeline-instructions" aria-labelledby="pipeline-instructions-heading" aria-busy={pending}>
    <h2 id="pipeline-instructions-heading">Instructions</h2>
    <p className="pipeline-settings-help">Pipeline’s shipped instructions are ready to use. Save team changes here; they apply to new tasks. Running tasks keep the instructions they started with.</p>
    <label className="pipeline-field"><span className="pipeline-field-label">Document</span>
      <PipelineSelect aria-label="Document" value={selected} disabled={pending || catalogue.length === 0}
        placeholder="Loading documents…"
        onValueChange={(value) => { setSelected(value as InstructionId); setSaveError(null); }}
        options={GROUPS.flatMap(([group, title]) => catalogue.filter((entry) => entry.group === group).map((entry) => ({
          value: entry.id, group: title,
          label: `${entry.title}${drafts[entry.id] ? " · Unsaved" : entry.source === "custom" ? " · Custom" : ""}`,
        })))} />
    </label>
    {shownError && <div className="pipeline-error" role="alert">{shownError}<button type="button" className="pipeline-button pipeline-ghost" disabled={pending} onClick={() => void refresh()}>Refresh instructions</button></div>}
    {!document ? <p role="status" className="pipeline-settings-help">{error ? "Instructions unavailable" : "Loading instructions…"}</p> : <>
      <div className="pipeline-instruction-status"><span>{document.source === "custom" ? "Saved custom instructions" : "Using shipped default"}</span><span>{draft ? "Unsaved changes" : "Saved"}</span></div>
      {externalGuidelines && <p className="pipeline-settings-help">New tasks use the external guidelines file configured above. This editor saves Pipeline’s own guidelines for when that file is cleared.</p>}
      {INSTRUCTION_FIELDS[selected]?.length ? <p className="pipeline-settings-help">Task details: {INSTRUCTION_FIELDS[selected]!.map((field) => `{{${field}}}`).join(", ")}</p> : null}
      {conflict && <div className="pipeline-instruction-conflict" role="alert">
        <p>The saved instructions changed while you were editing. Your draft is preserved. Compare with the saved version before saving.</p>
        <details><summary>Saved version</summary><pre>{document.content}</pre></details>
        <button type="button" className="pipeline-button" disabled={pending} onClick={() => setDrafts((current) => ({ ...current, [selected]: { ...current[selected]!, baseRevision: document.revision } }))}>Keep my draft</button>
      </div>}
      <label className="pipeline-field"><span className="pipeline-field-label">Instruction text</span>
        <textarea className="pipeline-input pipeline-instruction-editor" rows={18} value={content} disabled={pending} spellCheck={false} onChange={(event) => edit(applyInstructionEdit(content, event.target.value, event.target.selectionStart))} />
      </label>
      {draft && !validation.success && <p className="pipeline-error" role="alert">{validation.error.issues[0]?.message}</p>}
      {draft && fieldError && <p className="pipeline-error" role="alert">{fieldError}</p>}
      <details className="pipeline-instruction-default"><summary>Shipped default</summary><pre>{document.defaultContent}</pre></details>
      <div className="pipeline-instruction-actions">
        <span role="status" className="pipeline-settings-help">{notice}</span>
        <button type="button" className="pipeline-button pipeline-ghost" disabled={pending || (document.source === "default" && !draft)} onClick={() => {
          setDrafts((current) => ({ ...current, [selected]: { content: document.defaultContent, baseRevision: current[selected]?.baseRevision ?? document.revision, reset: true } }));
          setNotice("Shipped default selected. Save to apply.");
        }}>Restore default</button>
        <button type="button" className="pipeline-button pipeline-ghost" disabled={pending || !draft} onClick={discard}>Discard changes</button>
        <button type="button" className="pipeline-button pipeline-primary" disabled={pending || !draft || conflict || !validation.success || fieldError !== null} onClick={() => void save()}>{pending ? "Saving…" : "Save instructions"}</button>
      </div>
    </>}
  </section>;
}
