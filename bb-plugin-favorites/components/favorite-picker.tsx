import {
  favoriteSaveError,
  findModel,
  findProvider,
  projectHasHost,
} from "@/lib/favorites";
import type {
  Catalog,
  PickerHost,
  PickerProject,
  ReasoningLevel,
  ServiceTier,
} from "@/lib/schema";

const selectClass =
  "h-[34px] w-full min-w-0 rounded-[9px] border border-border bg-background px-2.5 text-[13px] text-foreground outline-none focus:border-ring disabled:opacity-40";

const fieldClass = "flex min-w-[8.5rem] flex-1 basis-[8.5rem] flex-col gap-1.5";

export function FavoritePicker({
  projects,
  hosts,
  catalog,
  catalogLoading,
  name,
  projectId,
  hostId,
  providerId,
  model,
  reasoningLevel,
  serviceTier,
  saving,
  error,
  onName,
  onProjectId,
  onHostId,
  onProviderId,
  onModel,
  onReasoningLevel,
  onServiceTier,
  onSave,
}: {
  projects: readonly PickerProject[];
  hosts: readonly PickerHost[];
  catalog: Catalog | null;
  catalogLoading: boolean;
  name: string;
  projectId: string;
  hostId: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | "";
  serviceTier: ServiceTier | "";
  saving: boolean;
  error: string | null;
  onName: (name: string) => void;
  onProjectId: (projectId: string) => void;
  onHostId: (hostId: string) => void;
  onProviderId: (providerId: string) => void;
  onModel: (model: string) => void;
  onReasoningLevel: (reasoningLevel: ReasoningLevel) => void;
  onServiceTier: (serviceTier: ServiceTier) => void;
  onSave: () => void;
}) {
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  const host = hosts.find((entry) => entry.id === hostId) ?? null;
  const provider = findProvider(catalog?.providers ?? [], providerId);
  const selectedModel = findModel(catalog?.models ?? [], model);
  const levels = selectedModel
    ? selectedModel.supportedReasoningEfforts.map(
        (entry) => entry.reasoningEffort,
      )
    : [];
  const speedEnabled = Boolean(provider?.supportsServiceTier);
  const validationError = favoriteSaveError({
    project,
    host,
    provider,
    model: selectedModel,
    reasoningLevel: reasoningLevel || null,
    serviceTier: speedEnabled ? serviceTier || null : null,
    catalogError: catalog?.error,
  });
  const usableHosts = hosts.filter(
    (entry) => !project || projectHasHost(project, entry.id),
  );

  return (
    <footer className="border-t border-border bg-background/80 px-4 py-3">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="text-[12px] font-medium tracking-[0.02em] text-muted-foreground uppercase">
          New favorite
        </h2>
        {catalogLoading ? (
          <span className="text-[12px] text-muted-foreground">
            Loading catalog…
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className={`${fieldClass} min-w-[12rem] basis-[12rem]`}>
          <span className="text-[11px] text-muted-foreground">Name</span>
          <input
            aria-label="Name"
            className={selectClass}
            value={name}
            placeholder="Optional"
            onChange={(event) => onName(event.target.value)}
          />
        </label>
        <label className={fieldClass}>
          <span className="text-[11px] text-muted-foreground">Project</span>
          <select
            aria-label="Project"
            className={selectClass}
            value={projectId}
            onChange={(event) => onProjectId(event.target.value)}
          >
            {projects.length === 0 ? (
              <option value="">No projects</option>
            ) : null}
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldClass}>
          <span className="text-[11px] text-muted-foreground">Machine</span>
          <select
            aria-label="Machine"
            className={selectClass}
            value={hostId}
            onChange={(event) => onHostId(event.target.value)}
          >
            {usableHosts.length === 0 ? (
              <option value="">No machines</option>
            ) : null}
            {usableHosts.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.status === "connected"
                  ? entry.name
                  : `${entry.name} (offline)`}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldClass}>
          <span className="text-[11px] text-muted-foreground">Harness</span>
          <select
            aria-label="Harness"
            className={selectClass}
            value={providerId}
            disabled={!catalog || catalogLoading}
            onChange={(event) => onProviderId(event.target.value)}
          >
            {(catalog?.providers ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.available
                  ? entry.displayName
                  : `${entry.displayName} (unavailable)`}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldClass}>
          <span className="text-[11px] text-muted-foreground">Model</span>
          <select
            aria-label="Model"
            className={selectClass}
            value={model}
            disabled={!catalog || catalogLoading}
            onChange={(event) => onModel(event.target.value)}
          >
            {(catalog?.models ?? []).map((entry) => (
              <option key={entry.id} value={entry.model}>
                {entry.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldClass}>
          <span className="text-[11px] text-muted-foreground">Reasoning</span>
          <select
            aria-label="Reasoning"
            className={selectClass}
            value={reasoningLevel}
            disabled={catalogLoading || levels.length === 0}
            onChange={(event) =>
              onReasoningLevel(event.target.value as ReasoningLevel)
            }
          >
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <label
          className={`${fieldClass} ${speedEnabled ? "" : "opacity-40"}`}
        >
          <span className="text-[11px] text-muted-foreground">Speed</span>
          <select
            aria-label="Speed"
            className={selectClass}
            value={speedEnabled ? serviceTier : ""}
            disabled={catalogLoading || !speedEnabled}
            onChange={(event) =>
              onServiceTier(event.target.value as ServiceTier)
            }
          >
            <option value="fast">Fast</option>
            <option value="default">Standard</option>
          </select>
        </label>
        <button
          type="button"
          className="h-[34px] shrink-0 rounded-[9px] bg-foreground px-3.5 text-[13px] font-semibold text-background disabled:opacity-50"
          disabled={saving || catalogLoading || !catalog || Boolean(validationError)}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error || catalog?.error ? (
        <p className="mt-2 text-[12px] text-destructive">
          {error ?? catalog?.error}
        </p>
      ) : null}
    </footer>
  );
}
