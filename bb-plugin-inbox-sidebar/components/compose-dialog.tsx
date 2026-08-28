import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRpc,
  type NewThreadComposerProps,
} from "@bb/plugin-sdk/app";
import type { boardRpcContract } from "@/server";
import { usePortalScopeProps } from "@/lib/portal-scope";

type Seeds = {
  title: string | null;
  projectId: string;
  environmentId: string;
  providerId: string;
  model?: string;
  reasoningLevel?: string;
  permissionMode?: string;
  serviceTier?: string;
  homePath: string | null;
  homes: Array<{ name: string; path: string }>;
  /** Agent automations that still target the thread being replaced. */
  targetingAutomations: Array<{ id: string; name: string }>;
};

/**
 * The draft's lead line, with a repoint note when automations still point at
 * the thread being replaced. The note rides in the first user message, so the
 * freshly-born assistant sees it and knows to repoint (its own id is the new
 * one) or tell you.
 */
function restartPrompt(replaceThreadId: string | null, seeds: Seeds): string {
  if (!replaceThreadId) return "";
  const lead = `Continue from thread ${replaceThreadId}.\n\n`;
  if (seeds.targetingAutomations.length === 0) return lead;
  const lines = seeds.targetingAutomations
    .map((automation) => `- ${automation.name} (${automation.id})`)
    .join("\n");
  return (
    lead +
    `This thread replaces the one above. These automations still target ` +
    `the archived thread and need repointing to this thread's id:\n${lines}\n`
  );
}

/**
 * bb's own new-thread compose surface in a dialog, seeded with one
 * assistant's home and settings. The draft opens prefilled with a pointer to
 * the thread being replaced — a fresh start, not a fork; the assistant reads
 * the old thread itself when it needs the history. Submitting spawns the new
 * thread from the typed message, then archives the thread it replaces.
 * Closing without submitting changes nothing.
 */
export function ComposeDialog({
  replaceThreadId,
  onClose,
  onNavigate,
}: {
  replaceThreadId: string | null;
  onClose: () => void;
  onNavigate: () => void;
}) {
  const rpc = useRpc<typeof boardRpcContract>();
  const navigate = useBbNavigate();
  const portalScope = usePortalScopeProps();
  const [seeds, setSeeds] = useState<Seeds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [homePath, setHomePath] = useState<string | null>(null);

  useEffect(() => {
    if (!replaceThreadId) return;
    let live = true;
    setSeeds(null);
    setError(null);
    setHomePath(null);
    rpc
      .call("assistantSeeds", { threadId: replaceThreadId })
      .then((result) => {
        if (!live) return;
        setSeeds(result);
        setHomePath(result.homePath);
      })
      .catch((cause: unknown) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
    };
  }, [replaceThreadId, rpc]);

  // The current path leads the list even when it is not a real home (a
  // mishomed thread sitting on the fleet root), so the default is visible.
  const homeOptions = useMemo(() => {
    if (!seeds) return [];
    const options = [...seeds.homes];
    if (
      seeds.homePath &&
      !options.some((home) => home.path === seeds.homePath)
    ) {
      options.unshift({
        name: seeds.homePath.split("/").filter(Boolean).pop() ?? seeds.homePath,
        path: seeds.homePath,
      });
    }
    return options;
  }, [seeds]);

  const name = seeds?.title ?? "assistant";
  return (
    <Dialog.Root
      open={replaceThreadId !== null}
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
    >
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
                className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-[18px]" />
              </button>
            </Dialog.Close>

            <Dialog.Title className="pr-10 text-lg font-semibold">
              New thread with {name}
            </Dialog.Title>
            <Dialog.Description className="mt-1.5 pr-8 text-sm leading-relaxed text-muted-foreground">
              Home decides where they run, over the environment picker below.
              Sending archives the current thread.
            </Dialog.Description>

            {homeOptions.length > 0 && (
              <label className="mt-3 flex items-center gap-2 text-sm">
                <span className="shrink-0 text-muted-foreground">Home</span>
                <select
                  value={homePath ?? ""}
                  onChange={(event) => setHomePath(event.target.value)}
                  className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {homeOptions.map((home) => (
                    <option key={home.path} value={home.path}>
                      {home.name} ({home.path})
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="mt-5">
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : seeds ? (
                <NewThreadComposer
                  defaultProjectId={seeds.projectId}
                  defaultProviderId={seeds.providerId}
                  defaultModel={seeds.model}
                  defaultReasoningLevel={
                    seeds.reasoningLevel as NewThreadComposerProps["defaultReasoningLevel"]
                  }
                  defaultPermissionMode={
                    seeds.permissionMode as NewThreadComposerProps["defaultPermissionMode"]
                  }
                  defaultServiceTier={
                    seeds.serviceTier as NewThreadComposerProps["defaultServiceTier"]
                  }
                  defaultEnvironment={{
                    type: "reuse",
                    environmentId: seeds.environmentId,
                  }}
                  initialPrompt={restartPrompt(replaceThreadId, seeds)}
                  draftKey={`restart-${replaceThreadId}`}
                  placeholder={`Message ${name}…`}
                  onSubmit={async (request) => {
                    if (!replaceThreadId) return;
                    const { newThreadId } = await rpc.call(
                      "createReplacementThread",
                      {
                        replaceThreadId,
                        title: seeds.title,
                        request,
                        homePath: homePath ?? undefined,
                      },
                    );
                    onClose();
                    navigate.toThread(newThreadId);
                    onNavigate();
                  }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Loading…</p>
              )}
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
