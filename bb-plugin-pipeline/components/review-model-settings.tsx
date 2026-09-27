import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, useRpc } from "@get-bb/plugin-sdk/app";
import type { ReviewModelSettings as Settings } from "@ratulsarna/agent-models";
import type { ReviewModels } from "@ratulsarna/agent-models/schema";
import type { rpcContract } from "../lib/contract";
import type { ExecutionSelection } from "../lib/execution";

export function ReviewModelSettings({ catalogHost }: { catalogHost: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<ReviewModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const request = useRef(0);
  const saving = useRef(false);
  const reload = useCallback(async () => {
    const id = ++request.current;
    try {
      const result = await rpc.call("getReviewModels", null);
      if (id !== request.current) return;
      setSaved(result); setDraft(null); setError(null); setNotice("");
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);
  useEffect(() => { void reload(); return () => { request.current += 1; }; }, [reload]);

  async function save() {
    if (!saved || saving.current) return;
    saving.current = true;
    const id = ++request.current;
    setPending(true); setError(null); setNotice("");
    try {
      const result = await rpc.call("updateReviewModels", {
        models: draft ?? saved.models, expectedRevision: saved.revision,
      });
      if (id !== request.current) return;
      setSaved(result); setDraft(null); setNotice("Review models saved");
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      if (id === request.current) setPending(false);
    }
  }

  const models = draft ?? saved?.models;
  const dirty = saved !== null && (saved.source === "defaults" ||
    (draft !== null && JSON.stringify(draft) !== JSON.stringify(saved.models)));
  return <section className="pipeline-settings-section" aria-labelledby="pipeline-review-models-heading">
    <h2 id="pipeline-review-models-heading">Review models</h2>
    <p className="pipeline-settings-help">Shared with pair-review and other tools on the BB server. File sync carries these choices to your other machines. Reviews already running keep their choices.</p>
    {saved && <p className="pipeline-settings-help">{saved.source === "defaults" ? "Using defaults. Saving creates " : "Saved in "}<code>{saved.path}</code>.</p>}
    {error && <p role="alert" className="pipeline-error">{error}</p>}
    {models && (["codex", "glm"] as const).map((role) => <div key={role} role="group" aria-label={role === "codex" ? "Codex reviewer" : "GLM reviewer"} className="pipeline-settings-role">
      <span className="pipeline-field-label">{role === "codex" ? "Codex" : "GLM"}</span>
      {catalogHost === "" ? <span className="pipeline-settings-selection">{models[role].model} · {models[role].reasoningLevel}</span> : <ProviderModelPicker
        key={`${role}-${catalogHost}`}
        className="pipeline-execution-picker"
        allowProviderChange={false}
        value={{ providerId: role === "codex" ? "codex" : "pi", model: models[role].model, reasoningLevel: models[role].reasoningLevel as ExecutionSelection["reasoningLevel"] }}
        routing={{ kind: "host", hostId: catalogHost }}
        disabled={pending}
        onChange={({ model, reasoningLevel }) => {
          setDraft({ ...models, [role]: { model, reasoningLevel } }); setNotice("");
        }}
      />}
    </div>)}
    <div className="pipeline-review-model-actions">
      <span role="status">{notice}</span>
      <button type="button" className="pipeline-button pipeline-ghost" disabled={pending} onClick={() => void reload()}>Reload review models</button>
      <button type="button" className="pipeline-button" disabled={pending || !dirty} onClick={() => void save()}>{pending ? "Saving review models…" : "Save review models"}</button>
    </div>
  </section>;
}
