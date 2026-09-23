import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/lib/contract";
import { pipelineSettingsSchema, type PipelineSettingsValues } from "@/lib/settings";
import { Icon } from "./icon";

type SettingsView = { values: PipelineSettingsValues; jevApiKeyConfigured: boolean };
type Machine = { id: string; name: string; status: string };
type Integrations = { github: { available: boolean; detail: string }; jev: { configured: boolean }; notify: { available: boolean; detail: string } };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function PipelineSettingsLink() {
  const navigate = useBbNavigate();
  return <div className="pipeline-ui"><button type="button" className="pipeline-button" onClick={() => navigate.toPluginPanel("board", { subPath: "settings" })}>Open Pipeline settings</button></div>;
}

export function PipelineSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [saved, setSaved] = useState<SettingsView | null>(null);
  const [edits, setEdits] = useState<Partial<PipelineSettingsValues>>({});
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [reviewMode, setReviewMode] = useState<"automatic" | "comment" | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [hostId, setHostId] = useState("");
  const [machineError, setMachineError] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const alive = useRef(true);
  const saving = useRef(false);

  const refresh = useCallback(async () => {
    if (saving.current) return;
    const request = ++sequence.current;
    try {
      const result = await rpc.call("getSettings", null);
      if (!alive.current || request !== sequence.current) return;
      setSaved(result);
      setError(null);
    } catch (cause) {
      if (alive.current && request === sequence.current) setError(message(cause));
    }
  }, [rpc]);

  const checkIntegrations = useCallback(async () => {
    setChecking(true);
    setIntegrationError(null);
    try {
      const result = await rpc.call("integrationStatus", null);
      if (alive.current) setIntegrations(result);
    } catch (cause) {
      if (alive.current) setIntegrationError(message(cause));
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [rpc]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    void checkIntegrations();
    void rpc.call("settingsMachines", null).then(({ machines: next }) => {
      if (!alive.current) return;
      setMachines(next);
      setHostId(next.find((machine) => machine.status === "connected")?.id ?? "");
    }, (cause) => { if (alive.current) setMachineError(message(cause)); });
    return () => { alive.current = false; sequence.current += 1; };
  }, [rpc, refresh, checkIntegrations]);
  useRealtime("settings:changed", refresh);

  const values = saved === null ? null : { ...saved.values, ...edits };
  const mode = reviewMode ?? (values?.reviewRequestComment === "" ? "automatic" : "comment");
  const dirty = Object.keys(edits).length > 0 || key.trim() !== "" || clearKey;
  const valid = values !== null && pipelineSettingsSchema.safeParse(values).success &&
    (mode === "automatic" || values.reviewRequestComment.trim() !== "");
  const catalogHost = machines.some((machine) => machine.id === hostId && machine.status === "connected") ? hostId : "";

  function edit<K extends keyof PipelineSettingsValues>(name: K, value: PipelineSettingsValues[K]) {
    setEdits((current) => {
      const next = { ...current, [name]: value };
      if (JSON.stringify(value) === JSON.stringify(saved?.values[name])) delete next[name];
      return next;
    });
    setNotice("");
  }

  function discard() {
    setEdits({}); setKey(""); setClearKey(false); setReviewMode(null); setNotice(""); setError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !valid || !dirty) return;
    saving.current = true;
    sequence.current += 1;
    setPending(true); setError(null); setNotice("");
    try {
      const result = await rpc.call("updateSettings", {
        values: edits,
        ...(clearKey ? { jevApiKey: null } : key.trim() === "" ? {} : { jevApiKey: key.trim() }),
      });
      if (!alive.current) return;
      setSaved(result); setEdits({}); setKey(""); setClearKey(false); setReviewMode(null); setNotice("Saved");
      saving.current = false;
      void refresh();
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      saving.current = false;
      if (alive.current) setPending(false);
    }
  }

  function toggle(name: "rememberExecution" | "autoReviewFollowup" | "notificationsEnabled" | "notifyQuestions" | "notifyFailures" | "notifyReview", label: string, disabled = false) {
    return <label className="pipeline-setting-toggle"><span>{label}</span><input type="checkbox" checked={values?.[name] ?? false} disabled={pending || disabled} onChange={(event) => edit(name, event.target.checked)} /></label>;
  }

  return <div className="pipeline-ui pipeline-settings">
    <form onSubmit={save} aria-label="Pipeline settings" aria-busy={pending}>
      <header className="pipeline-settings-header">
        <button type="button" className="pipeline-icon-button" aria-label="Back to tasks" disabled={pending} onClick={() => navigate.toPluginPanel("board")}><Icon name="ChevronLeft" /></button>
        <h1>Settings</h1>
        <span role="status" className="pipeline-settings-notice">{notice}</span>
        <button type="button" className="pipeline-button pipeline-ghost" disabled={!dirty || pending} onClick={discard}>Discard</button>
        <button type="submit" className="pipeline-button pipeline-primary" disabled={!dirty || !valid || pending}>{pending ? <Icon name="Loading" className="pipeline-spin" /> : null}Save</button>
      </header>
      <div className="pipeline-settings-body">
        {error === null ? null : <div className="pipeline-error" role="alert">{error}{saved === null ? <button type="button" className="pipeline-button" onClick={() => void refresh()}>Retry</button> : null}</div>}
        {values === null ? <p role="status">{error === null ? "Loading settings…" : "Settings unavailable"}</p> : <>
          <section className="pipeline-settings-section" aria-labelledby="pipeline-execution-heading">
            <h2 id="pipeline-execution-heading">Execution</h2>
            <label className="pipeline-field"><span className="pipeline-field-label">Model catalog</span>
              <select className="pipeline-input" value={hostId} disabled={pending || machines.length === 0} onChange={(event) => setHostId(event.target.value)}>
                <option value="">Choose a connected machine</option>
                {machines.map((machine) => <option key={machine.id} value={machine.id} disabled={machine.status !== "connected"}>{machine.name}{machine.status === "connected" ? "" : " · Offline"}</option>)}
              </select>
            </label>
            {machineError === null ? null : <p role="alert" className="pipeline-settings-help">Model catalog unavailable: {machineError}</p>}
            <p className="pipeline-settings-help">Defaults apply to new tasks on all machines. Existing tasks keep their choices.</p>
            {(["intake", "lead"] as const).map((role) => <div key={role} role="group" aria-label={role === "intake" ? "Intake" : "Lead"} className="pipeline-settings-role">
              <span className="pipeline-field-label">{role === "intake" ? "Intake" : "Lead"}</span>
              {catalogHost === "" ? <span className="pipeline-settings-selection">{values[role].providerId} · {values[role].model} · {values[role].reasoningLevel}</span> : <ProviderModelPicker key={`${role}-${catalogHost}`} className="pipeline-execution-picker" value={values[role]} onChange={(value) => edit(role, value)} routing={{ kind: "host", hostId: catalogHost }} disabled={pending} />}
            </div>)}
            {toggle("rememberExecution", "Remember last task’s choices")}
          </section>
          <section className="pipeline-settings-section" aria-labelledby="pipeline-capacity-heading">
            <h2 id="pipeline-capacity-heading">Capacity</h2>
            <label className="pipeline-setting-row"><span>Concurrent tasks <small>Per project and machine. Running tasks finish when lowered.</small></span><input className="pipeline-input" type="number" min={1} max={32} step={1} value={Number.isNaN(values.taskLimit) ? "" : values.taskLimit} disabled={pending} onChange={(event) => edit("taskLimit", event.target.valueAsNumber)} /></label>
          </section>
          <section className="pipeline-settings-section" aria-labelledby="pipeline-reviews-heading">
            <h2 id="pipeline-reviews-heading">External reviews</h2>
            <label className="pipeline-field"><span className="pipeline-field-label">Request review</span><select className="pipeline-input" value={mode} disabled={pending} onChange={(event) => {
              const next = event.target.value as "automatic" | "comment";
              setReviewMode(next);
              edit("reviewRequestComment", next === "automatic" ? "" : saved?.values.reviewRequestComment || "@codex review");
            }}><option value="automatic">Automatic on GitHub</option><option value="comment">Post a comment</option></select></label>
            {mode === "comment" ? <label className="pipeline-field"><span className="pipeline-field-label">Review request comment</span><textarea className="pipeline-input" maxLength={4000} rows={2} value={values.reviewRequestComment} disabled={pending} onChange={(event) => edit("reviewRequestComment", event.target.value)} /></label> : null}
            {toggle("autoReviewFollowup", "Send findings to the lead automatically")}
          </section>
          <section className="pipeline-settings-section" aria-labelledby="pipeline-notifications-heading">
            <h2 id="pipeline-notifications-heading">Notifications</h2>
            {toggle("notificationsEnabled", "Pipeline notifications")}
            {toggle("notifyQuestions", "Questions and approvals", !values.notificationsEnabled)}
            {toggle("notifyFailures", "Failures", !values.notificationsEnabled)}
            {toggle("notifyReview", "Review and merge decisions", !values.notificationsEnabled)}
          </section>
          <details className="pipeline-settings-section pipeline-settings-advanced">
            <summary>Advanced</summary>
            <label className="pipeline-field"><span className="pipeline-field-label">Permissions</span><select className="pipeline-input" value={values.permissionMode} disabled={pending} onChange={(event) => edit("permissionMode", event.target.value as PipelineSettingsValues["permissionMode"])}><option value="accept-edits">Accept edits</option><option value="auto">Auto</option><option value="full">Full</option></select></label>
            <label className="pipeline-field"><span className="pipeline-field-label">TypeSafe API key <span>{saved?.jevApiKeyConfigured ? "Configured" : "Not configured"}</span></span><input type="password" aria-label="TypeSafe API key" autoComplete="new-password" className="pipeline-input" placeholder="Leave blank to keep current key" value={key} disabled={pending || clearKey} maxLength={4096} onChange={(event) => setKey(event.target.value)} /></label>
            {saved?.jevApiKeyConfigured ? <label className="pipeline-setting-toggle"><span>Clear saved key</span><input type="checkbox" checked={clearKey} disabled={pending} onChange={(event) => { setClearKey(event.target.checked); setKey(""); }} /></label> : null}
            <label className="pipeline-setting-row"><span>Jev confidence threshold</span><input type="number" className="pipeline-input" min={0.5} max={1} step={0.01} disabled={pending} value={Number.isNaN(values.jevThreshold) ? "" : values.jevThreshold} onChange={(event) => edit("jevThreshold", event.target.valueAsNumber)} /></label>
          </details>
          <section className="pipeline-settings-section" aria-labelledby="pipeline-integrations-heading">
            <div className="pipeline-setting-row"><h2 id="pipeline-integrations-heading">Integrations</h2><button type="button" className="pipeline-button pipeline-ghost" disabled={checking} onClick={() => void checkIntegrations()}>{checking ? "Checking…" : "Refresh"}</button></div>
            {integrationError === null ? null : <p role="alert" className="pipeline-settings-help">{integrationError}</p>}
            <dl className="pipeline-settings-integrations"><dt>GitHub</dt><dd>{integrations?.github.detail ?? (integrationError === null ? "Checking…" : "Unavailable")}</dd><dt>Jev</dt><dd>{saved?.jevApiKeyConfigured ? "Key configured" : "Key not configured"}</dd><dt>Notify</dt><dd>{integrations?.notify.detail ?? (integrationError === null ? "Checking…" : "Unavailable")}</dd></dl>
          </section>
        </>}
      </div>
    </form>
  </div>;
}
