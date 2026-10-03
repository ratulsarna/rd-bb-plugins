import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { FolderConfig, FolderStatus, NodePhase, rpcContract, SyncStatus } from "./contract";
import { Button } from "./components/ui/button";

type Machine = { hostId: string; name: string; connected: boolean };
type DraftFolder = Omit<FolderConfig, "ignorePaths"> & { exclusions: string };

const phaseLabels: Record<NodePhase, string> = {
  disabled: "Disabled",
  paused: "Paused",
  offline: "Offline · reconcile on reconnect",
  "waiting-for-primary": "Waiting for the primary copy",
  pending: "Waiting to sync",
  syncing: "Syncing…",
  ready: "Up to date",
  error: "Sync error",
};
const inputClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not reach the sync service. Try again.";
}

function configuration(status: SyncStatus): FolderConfig[] {
  return status.folders.map(({ id, label, primaryHostId, nodes, ignorePaths }) => ({
    id, label, primaryHostId, ignorePaths: [...ignorePaths],
    nodes: nodes.map(({ hostId, path }) => ({ hostId, path })),
  }));
}

function FolderCard({ folder, machines, status, sync, resolve, busy }: {
  folder: FolderStatus;
  machines: Machine[];
  status: SyncStatus;
  sync(): void;
  resolve(id: number): void;
  busy: boolean;
}) {
  const machineName = (id: string) => machines.find((machine) => machine.hostId === id)?.name ?? id;
  const offline = folder.nodes.some((node) =>
    node.phase === "offline" || machines.find((machine) => machine.hostId === node.hostId)?.connected === false,
  );
  return (
    <section aria-label={folder.label} className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">{folder.label}</h2>
          <p className="text-sm text-muted-foreground">
            {folder.id === "assistants" ? "Shared assistant files" : folder.id === "vault" ? "Personal vault · shared memories" : "Shared files"}
          </p>
          <p className="text-xs text-muted-foreground">Primary: {machineName(folder.primaryHostId)} · seeds the first copy</p>
        </div>
        <Button variant="outline" size="sm" disabled={busy || !status.enabled || status.paused || offline} onClick={sync}>
          Sync now
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {folder.nodes.map((node) => {
          const machine = machines.find((entry) => entry.hostId === node.hostId);
          const phase = !status.enabled ? "disabled" : status.paused ? "paused" : machine?.connected === false ? "offline" : node.phase;
          return (
            <li key={node.hostId} className="py-3 space-y-1">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="font-medium">
                  {machineName(node.hostId)}{node.hostId === folder.primaryHostId && " · Primary"}
                </span>
                <span className="text-muted-foreground">
                  {machine ? machine.connected ? "Connected" : "Offline" : "Connection unknown"}
                </span>
              </div>
              <p className="text-sm break-all font-mono">{node.path}</p>
              <p className={phase === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
                {phaseLabels[phase]}
              </p>
              {node.error && <p className="text-sm text-destructive">{node.error}</p>}
            </li>
          );
        })}
      </ul>
      {offline && <p className="text-xs text-muted-foreground">Sync now waits for every mapped machine. It is available when they are all online.</p>}
      <details className="text-sm">
        <summary className="cursor-pointer">Folder exclusions ({folder.ignorePaths.length})</summary>
        {folder.ignorePaths.length ? (
          <ul className="mt-2 space-y-1 font-mono break-all">
            {folder.ignorePaths.map((path) => <li key={path}>{path}</li>)}
          </ul>
        ) : <p className="mt-2 text-muted-foreground">No additional exclusions. Built-in exclusions still apply.</p>}
      </details>
      {folder.openConflicts === 0 ? <p className="text-sm text-muted-foreground">No open conflicts.</p> : (
        <details className="rounded-md border border-border p-3 text-sm">
          <summary className="cursor-pointer">
            {folder.openConflicts} conflicting {folder.openConflicts === 1 ? "change" : "changes"} preserved
          </summary>
          <p className="mt-2 text-muted-foreground">Review and merge the preserved files, then delete the conflict copies you have resolved. Mark resolved acknowledges a reviewed conflict without changing files. Up to date can still include conflicts.</p>
          <ul className="mt-2 space-y-2">
            {folder.conflicts.map((conflict) => (
              <li key={conflict.id} className="break-all">
                <p>{conflict.path}</p>
                <p className="text-xs text-muted-foreground">
                  {conflict.conflictPath ?? "A deletion conflicted with an edit; the edited file was kept."}
                </p>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => resolve(conflict.id)}>Mark resolved</Button>
              </li>
            ))}
          </ul>
          {folder.openConflicts > folder.conflicts.length && <p className="mt-2 text-muted-foreground">Showing the newest {folder.conflicts.length} conflicts.</p>}
        </details>
      )}
    </section>
  );
}

function MappingEditor({ initial, machines, busy, saving, save, cancel }: {
  initial: FolderConfig[];
  machines: Machine[];
  busy: boolean;
  saving: boolean;
  save(folders: FolderConfig[]): void;
  cancel(): void;
}) {
  const [folders, setFolders] = useState<DraftFolder[]>(() => initial.map(({ ignorePaths, ...folder }) => ({
    ...folder, exclusions: ignorePaths.join("\n"),
  })));
  function update(index: number, patch: Partial<DraftFolder>) {
    setFolders((current) => current.map((folder, i) => i === index ? { ...folder, ...patch } : folder));
  }
  function addFolder(id: "assistants" | "vault", label: string) {
    setFolders([...folders, { id, label, primaryHostId: "", nodes: [], exclusions: "" }]);
  }
  return (
    <form aria-label="Edit folder mapping" className="space-y-4" onSubmit={(event) => {
      event.preventDefault();
      save(folders.map(({ exclusions, ...folder }) => ({
        ...folder, ignorePaths: exclusions.split("\n").map((path) => path.trim()).filter(Boolean),
      })));
    }}>
      <p className="text-sm text-muted-foreground">Saving applies the map to the current sync state. It keeps sync enabled, disabled, or paused as it is now. On active sync, changed mappings take effect immediately.</p>
      <fieldset disabled={busy} className="space-y-4">
        {folders.map((folder, index) => (
          <section key={folder.id} aria-label={`Edit ${folder.label || "new folder"}`} className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex gap-3 items-end">
              <label className="flex-1 space-y-1 text-sm">Folder name
                <input className={inputClass} required maxLength={80} value={folder.label} onChange={(event) => update(index, { label: event.target.value })} />
              </label>
              <Button type="button" variant="outline" size="sm" onClick={() => setFolders(folders.filter((_, i) => i !== index))}>Remove folder</Button>
            </div>
            {folder.nodes.map((node, nodeIndex) => (
              <div key={node.hostId} className="flex gap-3 items-end">
                <label className="flex-1 space-y-1 text-sm">
                  {machines.find((machine) => machine.hostId === node.hostId)?.name ?? node.hostId} path
                  <input className={inputClass} required value={node.path} placeholder="Absolute folder path" onChange={(event) => update(index, {
                    nodes: folder.nodes.map((entry, i) => i === nodeIndex ? { ...entry, path: event.target.value } : entry),
                  })} />
                </label>
                <Button type="button" variant="outline" size="sm" onClick={() => update(index, {
                  nodes: folder.nodes.filter((_, i) => i !== nodeIndex),
                  primaryHostId: folder.primaryHostId === node.hostId ? "" : folder.primaryHostId,
                })}>Remove machine</Button>
              </div>
            ))}
            <label className="block space-y-1 text-sm">Add a machine
              <select className={inputClass} value="" onChange={(event) => {
                const hostId = event.target.value;
                if (hostId) update(index, { nodes: [...folder.nodes, { hostId, path: "" }] });
              }}>
                <option value="">Select a machine…</option>
                {machines.filter((machine) => !folder.nodes.some((node) => node.hostId === machine.hostId)).map((machine) => (
                  <option key={machine.hostId} value={machine.hostId}>{machine.name}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-sm">Primary machine
              <select className={inputClass} required value={folder.primaryHostId} onChange={(event) => update(index, { primaryHostId: event.target.value })}>
                <option value="">Select the primary copy…</option>
                {folder.nodes.map((node) => <option key={node.hostId} value={node.hostId}>{machines.find((machine) => machine.hostId === node.hostId)?.name ?? node.hostId}</option>)}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">The selected primary copy seeds a new folder; later edits sync both ways.</p>
            <label className="block space-y-1 text-sm">Excluded paths
              <textarea className={inputClass} rows={3} value={folder.exclusions} onChange={(event) => update(index, { exclusions: event.target.value })} />
            </label>
            <p className="text-xs text-muted-foreground">One path per line, relative to this folder. Each also excludes its contents. Add machine-local tools, secrets, and runtime paths here. Built-in exclusions always apply.</p>
          </section>
        ))}
        <div className="flex flex-wrap gap-2">
          {!folders.some((folder) => folder.id === "assistants") && <Button type="button" variant="outline" onClick={() => addFolder("assistants", "Assistants")}>Add Assistants</Button>}
          {!folders.some((folder) => folder.id === "vault") && <Button type="button" variant="outline" onClick={() => addFolder("vault", "Personal vault")}>Add Personal vault</Button>}
          <Button type="submit">{saving ? "Saving…" : "Save mapping"}</Button>
          <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
        </div>
      </fieldset>
    </form>
  );
}

function SyncPage() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [readError, setReadError] = useState("");
  const [directoryError, setDirectoryError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState<FolderConfig[] | null>(null);
  const locked = useRef(false);
  const readGeneration = useRef(0);
  const refresh = useCallback(() => {
    const generation = ++readGeneration.current;
    void Promise.allSettled([rpc.call("status"), rpc.call("machineDirectory")]).then(([state, directory]) => {
      if (generation !== readGeneration.current) return;
      if (state.status === "fulfilled") {
        setStatus(state.value);
        setReadError("");
      } else setReadError(errorMessage(state.reason));
      if (directory.status === "fulfilled") {
        setMachines(directory.value);
        setDirectoryError("");
      } else {
        setMachines([]);
        setDirectoryError(errorMessage(directory.reason));
      }
    });
  }, [rpc]);
  useEffect(() => {
    if (connection === "connected") refresh();
    return () => { readGeneration.current++; };
  }, [refresh, connection]);
  useRealtime("status-changed", refresh);

  async function act(key: string, work: () => Promise<SyncStatus>, message: string, closeEditor = false) {
    if (locked.current || connection !== "connected") return;
    locked.current = true;
    readGeneration.current++;
    setPending(key);
    setError("");
    setNotice("");
    try {
      const next = await work();
      readGeneration.current++;
      setStatus(next);
      setReadError("");
      setNotice(message);
      if (closeEditor) setEditing(null);
    } catch (error) {
      setError(`${errorMessage(error)} Check the saved status before retrying if the connection was interrupted.`);
      refresh();
    } finally {
      locked.current = false;
      setPending(null);
    }
  }
  const busy = pending !== null || connection !== "connected";
  const controlsBlocked = busy || editing !== null || !!readError || !!status?.configError;
  const mapped = new Set(status?.folders.flatMap((folder) => folder.nodes.map((node) => node.hostId)));
  const unmapped = machines.filter((machine) => !mapped.has(machine.hostId));
  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
        <div>
          <h1 className="text-xl font-semibold">Private Sync</h1>
          <p className="mt-1 text-sm text-muted-foreground">Your assistants and personal vault, connected through your BB server.</p>
        </div>
        <p className="text-sm text-muted-foreground">Shared assistant files and vault memories sync both ways. File watchers send changes through the BB server; offline machines reconcile when they reconnect. Conversations stay on the selected execution machine.</p>
        {connection !== "connected" && <p role="status" className="text-sm text-muted-foreground">BB connection lost or connecting. Displayed status may be stale; controls are unavailable until reconnect.</p>}
        {[readError, directoryError, error, status?.configError].filter(Boolean).map((message, index) => <p key={index} role="alert" className="text-sm text-destructive">{message}</p>)}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {pending && <p role="status" className="text-sm text-muted-foreground">{pending === "configure" ? "Saving mapping…" : status?.folders.some((folder) => folder.id === pending) ? "Waiting for all mapped machines to finish syncing…" : "Updating sync controls…"}</p>}
        {!status && <p role="status" className="text-sm text-muted-foreground">{readError ? "Sync status is unavailable." : "Loading sync status…"}</p>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={refresh}>Refresh status</Button>
        {status && (
          <>
            <section aria-label="Sync controls" className="rounded-lg border border-border p-4 space-y-3">
              <h2 className="font-medium">{status.configError ? "Configuration needs attention" : !status.enabled ? "Disabled · sync is off" : status.paused ? "Enabled · paused" : "Enabled · watching for changes"}</h2>
              <p className="text-sm text-muted-foreground">
                {status.configError ? "Sync cannot use the saved folder map. No folders are syncing." : !status.enabled ? "No files are syncing. Sync starts disabled; saving a map does not enable it." : status.paused ? "The map is enabled, but all file transfers are paused. Resume to continue." : "Connected machines sync automatically. Check each machine below for progress or errors."}
                {!status.enabled && status.paused && " Pause is also set. After enabling, choose Resume to start."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy || editing !== null || !!readError || (!status.enabled && (!!status.configError || status.folders.length === 0))} onClick={() => void act("enabled", () => rpc.call("setEnabled", { enabled: !status.enabled }), status.enabled ? "Sync disabled." : status.paused ? "Sync enabled; still paused. Choose Resume to start." : "Sync enabled. Connected machines will begin syncing.")}>{status.enabled ? "Disable sync" : "Enable sync"}</Button>
                {status.enabled && <Button variant="outline" disabled={controlsBlocked} onClick={() => void act("pause", () => rpc.call(status.paused ? "resume" : "pause"), status.paused ? "Sync resumed." : "Sync paused.")}>{status.paused ? "Resume" : "Pause"}</Button>}
                <Button variant="outline" disabled={controlsBlocked} onClick={() => { setError(""); setNotice(""); setEditing(configuration(status)); }}>Edit folder mapping</Button>
              </div>
            </section>
            <div>
              <h2 className="font-medium">Folder mapping</h2>
              <p className="mt-1 text-sm text-muted-foreground">Each row is the physical copy on that machine. Only mapped machines sync.</p>
              <p className="mt-1 text-xs text-muted-foreground">Saved in BB server settings for plugin private-sync, in the folders setting (JSON). Edit it here; no config file is needed.</p>
            </div>
            {editing && <MappingEditor initial={editing} machines={machines} busy={busy} saving={pending === "configure"} cancel={() => setEditing(null)} save={(folders) => void act("configure", () => rpc.call("configure", { folders }), "Mapping saved. The enabled and paused settings were kept.", true)} />}
            {status.configError && <p className="text-sm text-muted-foreground">The saved map could not be read. Repair it in BB plugin settings before editing or enabling sync.</p>}
            {!status.configError && status.folders.length === 0 && <p className="text-sm text-muted-foreground">No folders mapped. Choose Edit folder mapping to add your folders and machines.</p>}
            {status.folders.map((folder) => <FolderCard key={folder.id} folder={folder} machines={machines} status={status} busy={controlsBlocked} resolve={(id) => void act("resolve", () => rpc.call("resolveConflict", { folderId: folder.id, id }), "Conflict marked resolved. Files were kept.")} sync={() => void act(folder.id, async () => {
              await rpc.call("sync", { folderId: folder.id, timeoutMs: 120_000 });
              return rpc.call("status");
            }, `${folder.label}: all mapped machines finished a fresh sync pass.`)} />)}
            {!status.configError && unmapped.length > 0 && <p className="text-sm text-muted-foreground">Not mapped · not synced: {unmapped.map((machine) => machine.name).join(", ")}.</p>}
          </>
        )}
        <details className="rounded-lg border border-border p-4 text-sm">
          <summary className="cursor-pointer font-medium">Exclusions, conflicts, and hub storage</summary>
          <div className="mt-3 space-y-3 text-muted-foreground">
            <p>Machine-local tools, secrets, and runtime files must stay excluded. Built-in exclusions cover Git and dependency folders, caches, .env files, .mcp.json, credentials, local settings, and Claude conversation/runtime directories. Folder exclusions above cover additional local paths; other files inside mapped roots sync.</p>
            <p>Conflicting edits are preserved as sync-conflict copies for you to review and merge. Offline changes are compared with the last agreed copy on reconnect.</p>
            <p>The mapping is saved in bb.db under the server BB_DATA_DIR, in plugin_settings for plugin private-sync, key folders; enabled is stored alongside it. Hub sync data is in plugins/private-sync/data.db under the same directory, with file contents in sibling blobs/. Your working files stay at the mapped paths above.</p>
          </div>
        </details>
      </div>
    </main>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sync",
    title: "Private Sync",
    icon: "FolderSync",
    path: "sync",
    component: SyncPage,
  });
});
