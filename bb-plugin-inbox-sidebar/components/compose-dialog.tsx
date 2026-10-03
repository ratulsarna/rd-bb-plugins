import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRpc,
  type NewThreadComposerProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { z } from "zod";
import type { AssistantDestination } from "@/lib/assistant-conversation";
import type { boardRpcContract } from "@/server";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { restartPrompt } from "@/lib/restart-prompt";

type Seeds = z.infer<typeof boardRpcContract.assistantSeeds.output>;

/** Starts a fresh root conversation through bb's normal composer. */
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
  const [seedResult, setSeedResult] = useState<{ threadId: string; value: Seeds } | null>(null);
  const seeds = seedResult?.threadId === replaceThreadId ? seedResult.value : null;
  const [error, setError] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [destinationResult, setDestinationResult] = useState<{ key: string; value: AssistantDestination } | null>(null);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [archiveSource, setArchiveSource] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const destinationKey = `${replaceThreadId}:${hostId}:${attempt}`;
  const currentKey = useRef(destinationKey);
  currentKey.current = destinationKey;
  const destination = destinationResult?.key === destinationKey ? destinationResult.value : null;

  useEffect(() => {
    let live = true;
    setSeedResult(null);
    setError(null);
    setHostId(null);
    setHomePath(null);
    if (replaceThreadId) {
      rpc.call("assistantSeeds", { threadId: replaceThreadId }).then((result) => {
        if (!live) return;
        setSeedResult({ threadId: replaceThreadId, value: result });
        setHostId(result.sourceHostId);
        setArchiveSource(false);
      }).catch((cause: unknown) => {
        if (live) setError(String(cause));
      });
    }
    return () => { live = false; };
  }, [replaceThreadId, rpc]);

  useEffect(() => {
    let live = true;
    setDestinationResult(null);
    setHomePath(null);
    if (replaceThreadId && hostId && seeds) {
      setError(null);
      rpc.call("assistantDestination", { threadId: replaceThreadId, hostId }).then((result) => {
        if (!live) return;
        setDestinationResult({ key: destinationKey, value: result });
        setHomePath(result.homePath);
      }).catch((cause: unknown) => {
        if (live) setError(String(cause));
      });
    }
    return () => { live = false; };
  }, [replaceThreadId, hostId, seeds, destinationKey, rpc]);

  const sameHost = seeds?.sourceHostId === hostId;
  const shouldArchive = sameHost && archiveSource;
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
              Start a fresh root conversation with an empty session. Machine and Home
              set its destination. {shouldArchive ? "Sending replaces and archives the selected conversation." : "The existing conversation stays intact."}
            </Dialog.Description>

            {seeds && (
              <>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <span className="shrink-0 text-muted-foreground">Machine</span>
                  <select aria-label="Machine" value={hostId ?? ""} disabled={submitting}
                    onChange={(event) => {
                      const next = event.target.value;
                      setHostId(next);
                      setArchiveSource(false);
                    }}
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5">
                    {seeds.machines.map((machine) => (
                      <option key={machine.hostId} value={machine.hostId}>
                        {machine.name} — {machine.connected ? "connected" : "offline"}{machine.reason ? `: ${machine.reason}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {destination && (
                  <>
                    <label className="mt-3 flex items-center gap-2 text-sm">
                      <span className="shrink-0 text-muted-foreground">Home</span>
                      <select aria-label="Home" value={homePath ?? ""} disabled={submitting || !destination.ready}
                        onChange={(event) => setHomePath(event.target.value)}
                        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5">
                        {destination.homes.map((home) => <option key={home.path} value={home.path}>{home.name} ({home.path})</option>)}
                      </select>
                    </label>
                    <p className="mt-2 break-all text-xs text-muted-foreground">Vault: {destination.vaultPath ?? "unmapped"}</p>
                    <p role="status" className="mt-2 text-sm text-muted-foreground">{destination.ready ? "Destination files are ready. Sending checks them again." : destination.reason}</p>
                    {!destination.providerAvailable && destination.ready && <p className="mt-2 text-xs text-muted-foreground">Choose an available provider and model below.</p>}
                  </>
                )}
                {sameHost && <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={archiveSource} disabled={submitting} onChange={(event) => setArchiveSource(event.target.checked)} />
                  Replace and archive the selected conversation after creation
                </label>}
                <button type="button" disabled={submitting} onClick={() => setAttempt((value) => value + 1)} className="mt-2 text-xs text-muted-foreground underline">Refresh destination</button>
              </>
            )}

            <div className="mt-5">
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : seeds && destination?.ready ? (
                <NewThreadComposer
                  defaultProjectId={seeds.projectId}
                  key={`${replaceThreadId}:${hostId}`}
                  defaultProviderId={destination.providerAvailable ? seeds.providerId : undefined}
                  defaultModel={destination.providerAvailable ? seeds.model : undefined}
                  defaultReasoningLevel={
                    (destination.providerAvailable ? seeds.reasoningLevel : undefined) as NewThreadComposerProps["defaultReasoningLevel"]
                  }
                  defaultPermissionMode={
                    seeds.permissionMode as NewThreadComposerProps["defaultPermissionMode"]
                  }
                  defaultServiceTier={
                    (destination.providerAvailable ? seeds.serviceTier : undefined) as NewThreadComposerProps["defaultServiceTier"]
                  }
                  defaultEnvironment={{
                    type: "host",
                    hostId: destination.hostId,
                    workspace: { type: "unmanaged", path: destination.homePath },
                  }}
                  initialPrompt={restartPrompt(replaceThreadId, { ...seeds, identity: destination.identity, vaultPath: destination.vaultPath, archiveSource: shouldArchive, crossMachine: !sameHost })}
                  draftKey={`restart-${replaceThreadId}-${hostId}-new`}
                  placeholder={`Message ${name}…`}
                  onSubmit={async (request) => {
                    if (!replaceThreadId || !hostId || !homePath || !destination.ready || submitting) return;
                    const key = destinationKey;
                    setSubmitting(true);
                    try {
                      const result = await rpc.call("createReplacementThread", {
                        replaceThreadId,
                        title: seeds.title,
                        request,
                        destinationHostId: hostId,
                        homePath,
                        archiveSource: shouldArchive,
                      });
                      if (result.archiveError) toast.error(`New conversation created; source was kept: ${result.archiveError}`);
                      if (currentKey.current !== key) return;
                      onClose();
                      navigate.toThread(result.newThreadId);
                      onNavigate();
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{destination && !destination.ready ? "Resolve the destination status, then refresh to compose." : "Loading…"}</p>
              )}
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
