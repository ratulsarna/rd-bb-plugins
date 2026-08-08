import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { experimental_useSidebarThreadActions as useSidebarThreadActions } from "@bb/plugin-sdk/app";
import type { BoardThread } from "@/lib/lanes";

/**
 * The sidebar's right-click menu.
 *
 * Replacing bb's thread list takes its context menu with it, so this restores
 * the actions the user loses. Deletion goes through `requestDelete`, which
 * opens bb's own confirmation instead of removing a subtree silently.
 */
export function RowContextMenu({
  thread,
  children,
}: {
  thread: BoardThread;
  children: ReactNode;
}) {
  const actions = useSidebarThreadActions();

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label="Thread actions"
          className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <Item onSelect={() => void actions.setRead(thread.id, thread.isUnread)}>
            {thread.isUnread ? "Mark read" : "Mark unread"}
          </Item>
          <Item
            onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
          >
            {thread.isPinned ? "Unpin" : "Pin"}
          </Item>
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

function Item({
  children,
  destructive = false,
  onSelect,
}: {
  children: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={`cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground ${
        destructive ? "text-destructive-text" : ""
      }`}
    >
      {children}
    </ContextMenu.Item>
  );
}
