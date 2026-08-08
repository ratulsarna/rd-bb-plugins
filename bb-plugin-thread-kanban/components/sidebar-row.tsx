import { useEffect, useRef } from "react";
import type { PluginSidebarPullRequest } from "@bb/plugin-sdk/app";
import { PrBadge, StatusSlot } from "@/components/row-parts";
import { RowContextMenu } from "@/components/row-context-menu";
import {
  statusLabelForItem,
  threadDisplayTitle,
  type BoardItem,
} from "@/lib/lanes";

interface SidebarRowProps {
  item: BoardItem;
  depth?: number;
  now: number;
  activeThreadId: string | null;
  expandedIds: ReadonlySet<string>;
  onToggleExpanded: (threadId: string) => void;
  onOpen: (threadId: string) => void;
  pullRequests: ReadonlyMap<string, PluginSidebarPullRequest | null>;
  /** Settle / Unsettle, provided by the list for root rows only. */
  action?: { label: string; run: () => void };
}

/**
 * One sidebar line: title, unread dot, PR badge, status or age. No project,
 * machine or branch tags — there is no room for them at this width, and the
 * wide panel already carries that detail.
 *
 * The open target is a full-bleed anchor under the buttons, because a
 * `<button>` inside an `<a>` is invalid interactive nesting. It carries the
 * host's shortcut attributes: drop them and nine bb shortcuts stop working.
 */
export function SidebarRow({
  item,
  depth = 0,
  now,
  activeThreadId,
  expandedIds,
  onToggleExpanded,
  onOpen,
  pullRequests,
  action,
}: SidebarRowProps) {
  const title = threadDisplayTitle(item.thread);
  const expanded = expandedIds.has(item.thread.id);
  const isActive = item.thread.id === activeThreadId;

  // The active row must be on screen, however far down its section sits.
  // Optional call: jsdom has no scrollIntoView.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [isActive]);

  return (
    <li className="list-none">
      <RowContextMenu thread={item.thread}>
        <div
          ref={rowRef}
          className={`group/row relative flex h-8 items-center gap-1.5 rounded-md pr-1.5 text-xs ${
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
          }`}
          style={{ paddingLeft: `${10 + depth * 12}px` }}
        >
          <a
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={item.thread.id}
            href="#"
            aria-label={title}
            title={statusLabelForItem(item)}
            onClick={(event) => {
              event.preventDefault();
              onOpen(item.thread.id);
            }}
            className="absolute inset-0 cursor-pointer rounded-md"
          />
          <span
            className={`pointer-events-none relative min-w-0 flex-1 truncate ${
              isActive ? "text-foreground" : "text-muted-foreground/80"
            } group-hover/row:text-foreground`}
          >
            {title}
          </span>
          {item.thread.isUnread && (
            <span
              aria-label="Unread"
              className="pointer-events-none relative size-1.5 shrink-0 rounded-full bg-primary"
            />
          )}
          <span className="pointer-events-none relative">
            <PrBadge pullRequest={pullRequests.get(item.thread.id) ?? null} />
          </span>
          {item.children.length > 0 && (
            <button
              type="button"
              className="relative inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.preventDefault();
                onToggleExpanded(item.thread.id);
              }}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${item.children.length} subagents`}
            >
              <span aria-hidden>{expanded ? "▾" : "▸"}</span>
            </button>
          )}
          {/* Settle shares the status cell instead of following it. Its own
              column would push the status off every other row's, and at this
              width there is nothing to spare. Rendered, not hidden, so it
              stays on the tab order. */}
          <span className="pointer-events-none relative flex shrink-0 items-center">
            <span className={action ? "group-hover/row:opacity-0" : undefined}>
              <StatusSlot item={item} now={now} />
            </span>
            {action && (
              <button
                type="button"
                className="pointer-events-auto absolute right-0 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-sidebar-accent px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100"
                onClick={(event) => {
                  event.preventDefault();
                  action.run();
                }}
              >
                {action.label}
              </button>
            )}
          </span>
        </div>
      </RowContextMenu>
      {expanded && item.children.length > 0 && (
        <ul className="flex flex-col gap-px">
          {item.children.map((child) => (
            <SidebarRow
              key={child.thread.id}
              item={child}
              depth={depth + 1}
              now={now}
              activeThreadId={activeThreadId}
              expandedIds={expandedIds}
              onToggleExpanded={onToggleExpanded}
              onOpen={onOpen}
              pullRequests={pullRequests}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
