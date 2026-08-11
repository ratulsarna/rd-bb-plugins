import { useEffect, useId, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Cancel01Icon,
  FolderAddIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import {
  getProjectPathError,
  normalizeProjectPath,
  projectNameFromPath,
} from "@/lib/project-path";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { ProjectFolderBrowser } from "@/components/project-folder-browser";

interface ProjectHost {
  id: string;
  name: string;
}

export function AddProjectButton({
  onCreated,
}: {
  onCreated: (projectId: string) => void;
}) {
  const rpc = useRpc<typeof boardRpcContract>();
  const hostSelectId = useId();
  const [open, setOpen] = useState(false);
  const [hosts, setHosts] = useState<readonly ProjectHost[]>([]);
  const [selectedHostId, setSelectedHostId] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portalScope = usePortalScopeProps();

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setHosts([]);
    setSelectedHostId("");
    setPath(null);
    setError(null);
    setLoading(true);
    void rpc
      .call("projectCreationContext", {})
      .then((context) => {
        if (cancelled) return;
        setHosts(context.hosts);
        setSelectedHostId(
          context.primaryHostId ?? context.hosts[0]?.id ?? "",
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause, "Could not load machines."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, rpc]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !path) return;

    const pathError = getProjectPathError(path);
    if (pathError) {
      setError(pathError);
      return;
    }
    if (!selectedHostId) {
      setError("No machine is online.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await rpc.call("addProject", {
        hostId: selectedHostId,
        path: normalizeProjectPath(path),
      });
      setOpen(false);
      onCreated(result.projectId);
    } catch (cause) {
      setError(errorMessage(cause, "Could not add the project."));
    } finally {
      setSaving(false);
    }
  };

  const selectedHost = hosts.find((host) => host.id === selectedHostId);
  const projectName = path ? projectNameFromPath(path) : "";

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next: boolean) => {
        if (!saving) setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Add project"
          title="Add project"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon
            icon={FolderAddIcon}
            className="size-4 max-md:pointer-coarse:size-5"
          />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <div
          {...portalScope}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            pointerEvents: "none",
          }}
        >
          <Dialog.Overlay className="pointer-events-auto fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="pointer-events-auto fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-6 text-foreground shadow-xl duration-150 focus:outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                disabled={saving}
                className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-[18px]" />
              </button>
            </Dialog.Close>

            <Dialog.Title className="pr-10 text-lg font-semibold">
              Add project
            </Dialog.Title>
            <Dialog.Description className="mt-1.5 pr-8 text-sm leading-relaxed text-muted-foreground">
              {selectedHost
                ? `Browse to the project folder on ${selectedHost.name}, or edit the path directly.`
                : "Choose a machine and browse to the project folder."}
            </Dialog.Description>

            <form
              className="mt-5 space-y-4"
              onSubmit={(event) => void submit(event)}
            >
              {hosts.length ? (
                <label htmlFor={hostSelectId} className="relative block">
                  <span className="sr-only">Machine</span>
                  <span className="pointer-events-none absolute left-3 top-1/2 size-2 -translate-y-1/2 rounded-full bg-emerald-400" />
                  <select
                    id={hostSelectId}
                    aria-label="Machine"
                    value={selectedHostId}
                    disabled={loading || saving}
                    onChange={(event) => {
                      setSelectedHostId(event.target.value);
                      setPath(null);
                      setError(null);
                    }}
                    className="h-11 w-full appearance-auto rounded-lg border border-input bg-background pl-8 pr-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {hosts.map((host) => (
                      <option key={host.id} value={host.id}>
                        {host.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : loading ? (
                <div className="flex h-11 items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    className="mr-2 size-4 animate-spin"
                  />
                  Loading machines…
                </div>
              ) : null}

              {selectedHostId ? (
                <ProjectFolderBrowser
                  key={selectedHostId}
                  hostId={selectedHostId}
                  disabled={saving}
                  onDirectoryChange={setPath}
                />
              ) : null}

              {projectName ? (
                <p className="text-sm text-muted-foreground">
                  Project name:{" "}
                  <span className="font-semibold text-foreground">
                    {projectName}
                  </span>
                </p>
              ) : null}
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : null}
              {!loading && hosts.length === 0 && !error ? (
                <p className="text-sm text-destructive">
                  No machine is online.
                </p>
              ) : null}

              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={loading || saving || !selectedHostId || !path}
                  className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? "Adding…" : "Add project"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
