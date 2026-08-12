import { useId } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { NewThreadRequest } from "@bb/plugin-sdk/app";
import { environmentForFavorite } from "@/lib/favorites";
import { usePortalScopeProps } from "@/lib/portal-scope";
import type { FavoriteSeed } from "@/lib/schema";
import type { rpcContract } from "../server";

export function ComposeOverlay({
  seed,
  sessionKey,
  onClose,
}: {
  seed: FavoriteSeed;
  sessionKey: string;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const reactId = useId();
  const draftKey = `favorites:${sessionKey}:${reactId}`;
  const portalScope = usePortalScopeProps();

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <div
          {...portalScope}
          className="pointer-events-none fixed inset-0 z-50"
        >
          <Dialog.Overlay className="pointer-events-auto fixed inset-0 bg-background/80" />
          <Dialog.Content className="pointer-events-auto fixed top-1/2 left-1/2 flex h-[calc(100vh-2rem)] max-h-[48rem] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground focus:outline-none">
            <div className="flex items-center justify-between border-b border-border px-3.5 py-3 text-[13px]">
              <div className="flex items-baseline gap-1.5">
                <Dialog.Title>New Thread</Dialog.Title>
                <Dialog.Description className="text-muted-foreground">
                  Seeded from favorite
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Close
                </button>
              </Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 p-3.5">
              <NewThreadComposer
                key={draftKey}
                draftKey={draftKey}
                defaultProjectId={seed.projectId}
                defaultProviderId={seed.providerId}
                defaultModel={seed.model}
                defaultReasoningLevel={seed.reasoningLevel}
                defaultServiceTier={seed.serviceTier}
                defaultEnvironment={environmentForFavorite({
                  projectKind: seed.projectKind,
                  hostId: seed.hostId,
                })}
                placeholder="Start typing…"
                layout="contained"
                focusRequest={1}
                onSubmit={async (request: NewThreadRequest) => {
                  const { threadId } = await rpc.call("createThread", {
                    request,
                  });
                  onClose();
                  navigate.toThread(threadId);
                }}
              />
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
