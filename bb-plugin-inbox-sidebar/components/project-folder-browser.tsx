import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowRight01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Edit02Icon,
  FolderAddIcon,
  FolderIcon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import {
  getFolderNameError,
  toBreadcrumb,
} from "@/lib/project-browser-path";

interface DirectoryListing {
  directory: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

interface ProjectFolderBrowserProps {
  hostId: string;
  disabled?: boolean;
  onDirectoryChange: (directory: string | null) => void;
}

export function ProjectFolderBrowser({
  hostId,
  disabled = false,
  onDirectoryChange,
}: ProjectFolderBrowserProps) {
  const rpc = useRpc<typeof boardRpcContract>();
  const [requestedPath, setRequestedPath] = useState<string | null>(null);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathValue, setPathValue] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pathInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    onDirectoryChange(null);

    void rpc
      .call("projectDirectory", { hostId, path: requestedPath })
      .then((nextListing) => {
        if (cancelled) return;
        setListing(nextListing);
        setPathValue(nextListing.directory);
        onDirectoryChange(nextListing.directory);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorMessage(cause, "Could not open this folder."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hostId, onDirectoryChange, requestedPath, rpc]);

  useEffect(() => {
    if (editingPath) pathInput.current?.focus();
  }, [editingPath]);

  useEffect(() => {
    if (creatingFolder) folderInput.current?.focus();
  }, [creatingFolder]);

  const navigateTo = (path: string) => {
    setCreatingFolder(false);
    setFolderError(null);
    setRequestedPath(path);
  };

  const submitEditedPath = () => {
    const path = pathValue.trim();
    if (!path) return;
    setEditingPath(false);
    setRequestedPath(path);
  };

  const submitFolder = async () => {
    if (!listing || creating) return;
    const trimmedName = folderName.trim();
    const nextError = getFolderNameError(trimmedName);
    if (nextError) {
      setFolderError(nextError);
      return;
    }

    setCreating(true);
    setFolderError(null);
    try {
      const result = await rpc.call("createProjectFolder", {
        hostId,
        parentPath: listing.directory,
        name: trimmedName,
      });
      navigateTo(result.path);
    } catch (cause) {
      setFolderError(errorMessage(cause, "Could not create the folder."));
    } finally {
      setCreating(false);
    }
  };

  const handleEnter = (
    event: KeyboardEvent<HTMLInputElement>,
    action: () => void,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      action();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setEditingPath(false);
      setCreatingFolder(false);
    }
  };

  const crumbs = listing ? toBreadcrumb(listing.directory) : [];
  const controlsDisabled = disabled || loading;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex min-h-12 items-center gap-1 border-b border-border px-2">
        {editingPath ? (
          <>
            <input
              ref={pathInput}
              aria-label="Project path"
              value={pathValue}
              disabled={disabled}
              onChange={(event) => setPathValue(event.target.value)}
              onKeyDown={(event) => handleEnter(event, submitEditedPath)}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <IconButton label="Open path" onClick={submitEditedPath}>
              <HugeiconsIcon icon={Tick02Icon} className="size-4" />
            </IconButton>
            <IconButton
              label="Cancel editing path"
              onClick={() => {
                setEditingPath(false);
                setPathValue(listing?.directory ?? "");
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
            </IconButton>
          </>
        ) : (
          <>
            <IconButton
              label="Parent folder"
              disabled={controlsDisabled || !listing?.parent}
              onClick={() => listing?.parent && navigateTo(listing.parent)}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} className="size-[18px]" />
            </IconButton>
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-1 [scrollbar-width:none]">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="flex shrink-0 items-center">
                  {index > 0 ? (
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      className="mx-0.5 size-3.5 text-muted-foreground"
                    />
                  ) : null}
                  <button
                    type="button"
                    disabled={disabled || loading}
                    onClick={() => navigateTo(crumb.path)}
                    className="rounded px-1.5 py-1 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </div>
            <IconButton
              label="New folder"
              disabled={controlsDisabled || !listing}
              onClick={() => {
                setFolderName("");
                setFolderError(null);
                setCreatingFolder(true);
              }}
            >
              <HugeiconsIcon icon={FolderAddIcon} className="size-[18px]" />
            </IconButton>
            <IconButton
              label="Edit path"
              disabled={controlsDisabled}
              onClick={() => {
                setPathValue(listing?.directory ?? "");
                setEditingPath(true);
              }}
            >
              <HugeiconsIcon icon={Edit02Icon} className="size-[18px]" />
            </IconButton>
          </>
        )}
      </div>

      <div className="h-64 overflow-y-auto p-1.5">
        {creatingFolder && listing ? (
          <div className="mb-1 rounded-md bg-accent p-2">
            <div className="flex items-center gap-2">
              <HugeiconsIcon
                icon={FolderIcon}
                className="size-[18px] shrink-0 text-muted-foreground"
              />
              <input
                ref={folderInput}
                aria-label="New folder name"
                value={folderName}
                disabled={creating}
                placeholder="Folder name"
                onChange={(event) => {
                  setFolderName(event.target.value);
                  setFolderError(null);
                }}
                onKeyDown={(event) => handleEnter(event, () => void submitFolder())}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <IconButton
                label="Create folder"
                disabled={creating}
                onClick={() => void submitFolder()}
              >
                {creating ? (
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    className="size-4 animate-spin"
                  />
                ) : (
                  <HugeiconsIcon icon={Tick02Icon} className="size-4" />
                )}
              </IconButton>
              <IconButton
                label="Cancel new folder"
                disabled={creating}
                onClick={() => setCreatingFolder(false)}
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
              </IconButton>
            </div>
            {folderError ? (
              <p className="mt-1 pl-7 text-xs text-destructive">{folderError}</p>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <HugeiconsIcon icon={Loading03Icon} className="size-5 animate-spin" />
            <span className="ml-2 text-sm">Opening folder…</span>
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
            {error}
          </div>
        ) : listing?.entries.length ? (
          <div className="space-y-0.5">
            {listing.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                disabled={disabled}
                onClick={() => navigateTo(entry.path)}
                className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <HugeiconsIcon
                  icon={FolderIcon}
                  className="size-[18px] shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </button>
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            This folder is empty.
          </div>
        )}
      </div>
    </div>
  );
}

function IconButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
