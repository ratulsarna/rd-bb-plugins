import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, useRpc } from "@get-bb/plugin-sdk/app";
import type { AgentModelSettings as Settings } from "@ratulsarna/agent-models";
import type { AgentModels, ModelSelection } from "@ratulsarna/agent-models/schema";
import type { rpcContract } from "../lib/contract";
import type { ExecutionSelection } from "../lib/execution";
import { REVIEWER_ROLES, SUBAGENT_ROLES } from "../lib/agent-models";

const GROUPS = [
  { key: "review", title: "Review", help: "Shared with pair-review.", roles: REVIEWER_ROLES },
  { key: "subagents", title: "Subagents", help: "Added to every new BB thread's instructions. Running threads keep their table.", roles: SUBAGENT_ROLES },
] as const;

export function AgentModelSettings({ catalogHost }: { catalogHost: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<AgentModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const request = useRef(0);
  const saving = useRef(false);
  const reload = useCallback(async () => {
    const id = ++request.current;
    try {
      const result = await rpc.call("getAgentModels", null);
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
      const result = await rpc.call("updateAgentModels", {
        models: draft ?? saved.models, expectedRevision: saved.revision,
      });
      if (id !== request.current) return;
      setSaved(result); setDraft(null); setNotice("Agent models saved");
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
  return <section className="pipeline-settings-section" aria-labelledby="pipeline-agent-models-heading">
    <h2 id="pipeline-agent-models-heading">Agent models</h2>
    <p className="pipeline-settings-help">Saved on the BB server. File sync carries these choices to your other machines.</p>
    {saved && <p className="pipeline-settings-help">{saved.source === "defaults" ? "Using defaults. Saving creates " : "Saved in "}<code>{saved.path}</code>.</p>}
    {error && <p role="alert" className="pipeline-error">{error}</p>}
    {models && GROUPS.map((group) => <div key={group.key} role="group" aria-labelledby={`pipeline-agent-models-${group.key}`} className="pipeline-settings-group">
      <h3 id={`pipeline-agent-models-${group.key}`}>{group.title}</h3>
      <p className="pipeline-settings-help">{group.help}</p>
      {group.roles.map(([role, label]) => {
        const slots: Record<string, ModelSelection> = models[group.key];
        const selection = slots[role]!;
        return <div key={role} role="group" aria-label={label} className="pipeline-settings-role">
          <span className="pipeline-field-label">{label}</span>
          {catalogHost === "" ? <span className="pipeline-settings-selection">{selection.providerId} · {selection.model} · {selection.reasoningLevel}</span> : <ProviderModelPicker
            key={`${role}-${catalogHost}`}
            className="pipeline-execution-picker"
            value={{ ...selection, reasoningLevel: selection.reasoningLevel as ExecutionSelection["reasoningLevel"] }}
            routing={{ kind: "host", hostId: catalogHost }}
            disabled={pending}
            onChange={(next) => {
              setDraft({ ...models, [group.key]: { ...models[group.key], [role]: next } }); setNotice("");
            }}
          />}
        </div>;
      })}
    </div>)}
    <div className="pipeline-agent-model-actions">
      <span role="status">{notice}</span>
      <button type="button" className="pipeline-button pipeline-ghost" disabled={pending} onClick={() => void reload()}>Reload agent models</button>
      <button type="button" className="pipeline-button" disabled={pending || !dirty} onClick={() => void save()}>{pending ? "Saving agent models…" : "Save agent models"}</button>
    </div>
  </section>;
}
