import { useRef, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { bbSidebarRpcContract } from "./server";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";
import { ProjectActions } from "./ProjectContextMenu";
import { canParkThread, type ConfiguredSnoozePreset } from "./lifecycle";
import { beginTitleGeneration, finishTitleGeneration, useTitleGenerating } from "./title-generation-state";

/**
 * This sidebar's own right-click menu.
 *
 * The plugin API ships no menu component on purpose, so a replaced sidebar
 * owns this surface. Native actions use
 * `experimental_useSidebarThreadActions`, and the destructive one is
 * `requestDelete`, which opens BB's confirmation rather than deleting a
 * subtree silently.
 */
export function RowContextMenu({
  thread,
  children,
  canSnooze = false,
  canArchive = true,
  snoozePresets = [],
  onSnooze,
  onSettle,
  onUnsettle,
  onWake,
  onRename,
}: {
  thread: PluginSidebarThread;
  children: ReactNode;
  canSnooze?: boolean;
  canArchive?: boolean;
  snoozePresets?: readonly ConfiguredSnoozePreset[];
  onSnooze?: (snoozedUntil: number) => void;
  onSettle?: () => void;
  onUnsettle?: () => void;
  onWake?: () => void;
  onRename?: () => void;
}) {
  const actions = useSidebarThreadActions();
  const { projects, threads } = useSidebarThreads();
  const project = projects.find((project) => project.id === thread.projectId);
  const portalScope = usePortalScopeProps();
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const regenerating = useTitleGenerating(thread.id);
  const renameAfterClose = useRef(false);
  // Archive takes the children with it, and bb leaves every idle one's agent
  // session loaded. Release them alongside the archive. Working children are
  // skipped, so this never interrupts a turn archive itself would not.
  const archive = () => {
    actions.archive(thread.id);
    const threadIds = [
      thread.id,
      ...threads
        .filter(
          (child) =>
            child.parentThreadId === thread.id && canParkThread(child),
        )
        .map((child) => child.id),
    ];
    void rpc.call("releaseRuntimes", { threadIds }).catch(() => {
      void 0; // A missed release costs memory, not correctness.
    });
  };
  const regenerate = async () => {
    if (!beginTitleGeneration(thread.id)) return;
    try {
      await rpc.call("regenerateTitle", { threadId: thread.id });
      toast.success("Thread title regenerated");
    } catch (error) {
      toast.error("Could not regenerate title", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      finishTitleGeneration(thread.id);
    }
  };

  return (
    <ProjectActions project={project}>
    {({ items: projectItems, onOpenChange, onCloseAutoFocus }) => (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...portalScope}
          aria-label="Thread actions"
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (!renameAfterClose.current) return;
            renameAfterClose.current = false;
            // Hand focus to the editor after the menu releases its focus scope.
            event.preventDefault();
            onRename?.();
          }}
          className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <Item onSelect={() => actions.open(thread.id, { split: true })}>
            Open in split
          </Item>
          {projectItems ? (
            <ContextMenu.Sub onOpenChange={onOpenChange}>
              <ContextMenu.SubTrigger className="flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none data-[state=open]:bg-accent data-[highlighted]:bg-accent">
                Project
                <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent {...portalScope} aria-label="Project actions" sideOffset={4}
                  className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  <ContextMenu.Label className="max-w-64 truncate px-2 py-1 text-xs text-muted-foreground">{project?.name}</ContextMenu.Label>
                  {projectItems}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          ) : null}
          <Separator />
          <Item
            onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
          >
            {thread.isPinned ? "Unpin" : "Pin"}
          </Item>
          {onSettle ? <Item onSelect={onSettle}>Settle</Item> : null}
          {onUnsettle ? <Item onSelect={onUnsettle}>Un-settle</Item> : null}
          {canSnooze && onSnooze && snoozePresets.length > 0 ? (
            <SnoozeSubmenu presets={snoozePresets} onSnooze={onSnooze} />
          ) : null}
          {onWake ? <Item onSelect={onWake}>Wake now</Item> : null}
          <Separator />
          {onRename ? (
            <Item onSelect={() => { renameAfterClose.current = true; }}>
              Rename
            </Item>
          ) : null}
          <Item disabled={regenerating} onSelect={() => void regenerate()}>
            {regenerating ? "Regenerating title…" : "Regenerate title"}
          </Item>
          <Item
            onSelect={() => void actions.setRead(thread.id, thread.isUnread)}
          >
            {thread.isUnread ? "Mark read" : "Mark unread"}
          </Item>
          <Separator />
          <CopySubmenu thread={thread} />
          <Separator />
          <Item
            disabled={!canArchive}
            onSelect={archive}
          >
            Archive
          </Item>
          <Item destructive onSelect={() => actions.requestDelete(thread.id)}>
            Delete
          </Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    )}
    </ProjectActions>
  );
}

function CopySubmenu({ thread }: { thread: PluginSidebarThread }) {
  const { projects } = useSidebarThreads();
  const branchName = thread.environment?.branchName;
  const copy = (text: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text);
  };
  const copyThreadLink = async () => {
    const isPersonal = projects.some(
      (project) => project.id === thread.projectId && project.isPersonal,
    );
    const threadPath = `/threads/${encodeURIComponent(thread.id)}`;
    const path = isPersonal
      ? threadPath
      : `/projects/${encodeURIComponent(thread.projectId)}${threadPath}`;
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      toast.success("Thread link copied");
    } catch {
      toast.error("Failed to copy thread link");
    }
  };

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none",
          "data-[state=open]:bg-accent data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        )}
      >
        Copy
        <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          aria-label="Copy thread data"
          sideOffset={4}
          className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <Item onSelect={() => void copyThreadLink()}>Copy thread link</Item>
          {branchName ? (
            <Item onSelect={() => copy(branchName)}>
              Copy branch
            </Item>
          ) : null}
          <Item onSelect={() => copy(thread.id)}>Copy thread ID</Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

function SnoozeSubmenu({
  presets,
  onSnooze,
}: {
  presets: readonly ConfiguredSnoozePreset[];
  onSnooze: (snoozedUntil: number) => void;
}) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none",
          "data-[state=open]:bg-accent data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        )}
      >
        Snooze
        <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          aria-label="Snooze times"
          sideOffset={4}
          className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {presets.map((preset) => (
            <Item
              key={preset.id}
              onSelect={() => onSnooze(Date.now() + preset.durationMs)}
            >
              {preset.label}
            </Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

function Item({
  children,
  destructive = false,
  disabled = false,
  onSelect,
}: {
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        destructive && "text-destructive-text",
      )}
    >
      {children}
    </ContextMenu.Item>
  );
}

function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border" />;
}
