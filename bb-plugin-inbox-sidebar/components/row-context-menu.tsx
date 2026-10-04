import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { experimental_useSidebarThreadActions as useSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BoardThread } from "@/lib/lanes";
import type { PinnedMove } from "@/lib/pinned-order";
import { usePortalScopeProps } from "@/lib/portal-scope";

const MENU_CLASS =
  "z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md";

/**
 * The sidebar's right-click menu.
 *
 * Replacing bb's thread list takes its context menu with it, so this restores
 * the actions the user loses. Deletion goes through `requestDelete`, which
 * opens bb's own confirmation instead of removing a subtree silently.
 */
export function RowContextMenu({
  thread,
  pinnedMove,
  action,
  onSnooze,
  onRename,
  filteredProjectId,
  onToggleProjectFilter,
  children,
}: {
  thread: BoardThread;
  /** Present only on pinned roots, and only once bb's order is known. */
  pinnedMove?: PinnedMove;
  /** The row's hover action (Settle / Unsettle / Wake), repeated here. */
  action?: { label: string; run: () => void };
  /** Opens the row's snooze picker. */
  onSnooze?: () => void;
  onRename: () => void;
  /** The list's project filter; "" means every project. */
  filteredProjectId: string;
  onToggleProjectFilter: (projectId: string) => void;
  children: ReactNode;
}) {
  const actions = useSidebarThreadActions();
  const portalScope = usePortalScopeProps();

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...portalScope}
          aria-label="Thread actions"
          className={MENU_CLASS}
        >
          {/* The only way to reorder pins on the wide panel and on a phone,
              where there is no drag handle. */}
          {pinnedMove && (
            <>
              <Item
                disabled={!pinnedMove.canMoveUp}
                onSelect={pinnedMove.moveUp}
              >
                Move up
              </Item>
              <Item
                disabled={!pinnedMove.canMoveDown}
                onSelect={pinnedMove.moveDown}
              >
                Move down
              </Item>
              <ContextMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}
          {/* A phone has no hover, so a long-press here is the only way to
              reach the row's hover controls. */}
          {(onSnooze || action) && (
            <>
              {onSnooze && (
                <Item
                  onSelect={() => {
                    // Let Radix close the menu before the picker takes focus.
                    window.setTimeout(onSnooze, 0);
                  }}
                >
                  Snooze…
                </Item>
              )}
              {action && <Item onSelect={action.run}>{action.label}</Item>}
              <ContextMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}
          <Item onSelect={() => void actions.setRead(thread.id, thread.isUnread)}>
            {thread.isUnread ? "Mark read" : "Mark unread"}
          </Item>
          <Item
            onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
          >
            {thread.isPinned ? "Unpin" : "Pin"}
          </Item>
          <Item
            onSelect={() => {
              // Let Radix close the menu before the editor takes focus.
              window.setTimeout(onRename, 0);
            }}
          >
            Rename
          </Item>
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <Item onSelect={() => onToggleProjectFilter(thread.projectId)}>
            {filteredProjectId === thread.projectId
              ? "Show all projects"
              : "Filter by this project"}
          </Item>
          <CopySubmenu thread={thread} />
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <Item onSelect={() => actions.archive(thread.id)}>Archive</Item>
          <Item destructive onSelect={() => actions.requestDelete(thread.id)}>
            Delete
          </Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function CopySubmenu({ thread }: { thread: BoardThread }) {
  const portalScope = usePortalScopeProps();
  const path = thread.environment?.path;
  const branchName = thread.environment?.branchName;

  // No clipboard at all (plain-http origin) lands in the catch too.
  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className="flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent">
        Copy
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="ml-auto size-4 opacity-60"
        />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          {...portalScope}
          aria-label="Copy thread data"
          sideOffset={4}
          className={MENU_CLASS}
        >
          <Item
            onSelect={() =>
              void copy(
                "Thread link",
                new URL(thread.href, window.location.origin).href,
              )
            }
          >
            Copy thread link
          </Item>
          {path && <Item onSelect={() => void copy("Path", path)}>Copy path</Item>}
          {branchName && (
            <Item onSelect={() => void copy("Branch", branchName)}>Copy branch</Item>
          )}
          <Item onSelect={() => void copy("Thread ID", thread.id)}>
            Copy thread ID
          </Item>
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
      className={`cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${
        destructive ? "text-destructive-text" : ""
      }`}
    >
      {children}
    </ContextMenu.Item>
  );
}
