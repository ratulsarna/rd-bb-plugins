import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
} from "react";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  experimental_useSidebarThreadSplit,
  type PluginSidebarPullRequest,
} from "@bb/plugin-sdk/app";
import { ProviderIcon } from "@/components/provider-icon";
import { isolatedRowGestureProps } from "@/components/row-gesture";
import { OpenPrLink, StatusSlot } from "@/components/row-parts";
import { RowContextMenu } from "@/components/row-context-menu";
import {
  statusLabelForItem,
  threadDisplayTitle,
  type BoardItem,
} from "@/lib/lanes";
import type { PinnedMove } from "@/lib/pinned-order";

/** dnd-kit's sortable bindings for a pinned root. */
export interface RowReorder {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  setNodeRef(node: HTMLElement | null): void;
  setActivatorNodeRef(node: HTMLElement | null): void;
  isDragging: boolean;
  style: CSSProperties;
}

interface SidebarRowProps {
  item: BoardItem;
  projectNames: ReadonlyMap<string, string>;
  depth?: number;
  now: number;
  activeThreadId: string | null;
  expandedIds: ReadonlySet<string>;
  onToggleExpanded: (threadId: string) => void;
  onOpen: (threadId: string) => void;
  pullRequests: ReadonlyMap<string, PluginSidebarPullRequest | null>;
  /** Settle / Unsettle, provided by the list for root rows only. */
  action?: { label: string; run: () => void };
  /** Pinned-root reordering, for the context menu and pointer gesture. */
  pinnedMove?: PinnedMove;
  /** Absent on compact viewports and off the Pinned section. */
  reorder?: RowReorder;
}

/**
 * One compact two-line sidebar row. The title line owns provider and PR; the
 * metadata line keeps project, machine and status in a single clipped line.
 *
 * Three weights carry the hierarchy, because at this width nothing else can:
 * the title is bright and semibold, the project sits in a tinted chip, and the
 * machine is the faintest text on the row.
 *
 * The open target is a full-bleed anchor under the buttons, because a
 * `<button>` inside an `<a>` is invalid interactive nesting. It carries the
 * host's shortcut attributes: drop them and nine bb shortcuts stop working.
 */
export function SidebarRow({
  item,
  projectNames,
  depth = 0,
  now,
  activeThreadId,
  expandedIds,
  onToggleExpanded,
  onOpen,
  pullRequests,
  action,
  pinnedMove,
  reorder,
}: SidebarRowProps) {
  const title = threadDisplayTitle(item.thread);
  const expanded = expandedIds.has(item.thread.id);
  const isActive = item.thread.id === activeThreadId;
  const projectName =
    projectNames.get(item.thread.projectId) ?? "Unknown project";
  const machineName = item.thread.host?.name ?? "Unknown machine";
  const openThread = () => onOpen(item.thread.id);
  const { splitProps } = experimental_useSidebarThreadSplit(item.thread.id);

  // The active row must be on screen, however far down its section sits.
  // Optional call: jsdom has no scrollIntoView.
  const rowRef = useRef<HTMLDivElement>(null);
  const setActivatorNodeRef = reorder?.setActivatorNodeRef;
  const setInteractionRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      setActivatorNodeRef?.(node);
    },
    [setActivatorNodeRef],
  );
  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [isActive]);

  return (
    <li
      ref={reorder?.setNodeRef}
      className="list-none"
      data-pinned-reordering={reorder?.isDragging || undefined}
      style={reorder?.style}
    >
      <RowContextMenu thread={item.thread} pinnedMove={pinnedMove}>
        <div
          ref={setInteractionRef}
          className={`group/row relative flex h-[54px] flex-col justify-center gap-0.5 rounded-md pr-1.5 text-xs ${
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
          } ${reorder ? "select-none touch-manipulation" : ""}`}
          style={{ paddingLeft: `${10 + depth * 12}px` }}
          {...(reorder?.attributes ?? {})}
          {...(reorder?.listeners ?? {})}
          {...splitProps}
        >
          {/* Prevent the browser's href drag from stealing the row gesture. */}
          <a
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={item.thread.id}
            href="#"
            aria-label={title}
            title={statusLabelForItem(item)}
            draggable={false}
            onClick={(event) => {
              event.preventDefault();
              openThread();
            }}
            className="absolute inset-0 cursor-pointer rounded-md"
          />
          <div className="pointer-events-none relative flex h-5 w-full min-w-0 items-center gap-1.5">
            <span className="inline-flex shrink-0">
              <ProviderIcon providerId={item.thread.providerId} />
            </span>
            <span
              className={`pointer-events-auto min-w-0 flex-1 cursor-pointer truncate text-[13px] font-semibold tracking-tight ${
                isActive ? "text-foreground" : "text-foreground/90"
              } group-hover/row:text-foreground`}
              title={title}
              onClick={openThread}
            >
              {title}
            </span>
            <OpenPrLink
              pullRequest={pullRequests.get(item.thread.id) ?? null}
            />
            {item.children.length > 0 && (
              <button
                type="button"
                className="pointer-events-auto relative inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                {...isolatedRowGestureProps}
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
          </div>
          {/* Settle shares the status cell instead of following it. Its own
              column would push the status off every other row's, and at this
              width there is nothing to spare. Rendered, not hidden, so it
              stays on the tab order. */}
          <div className="pointer-events-none relative flex h-[18px] w-full min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
            <span
              className="pointer-events-auto max-w-[45%] min-w-0 shrink cursor-pointer truncate rounded bg-foreground/[0.07] px-1.5 py-px font-medium text-muted-foreground"
              title={`Project: ${projectName}`}
              onClick={openThread}
            >
              {projectName}
            </span>
            <span
              className="pointer-events-auto min-w-0 flex-1 cursor-pointer truncate text-muted-foreground/70"
              title={`Machine: ${machineName}`}
              onClick={openThread}
            >
              {machineName}
            </span>
            <span className="pointer-events-none relative flex shrink-0 items-center gap-1.5">
              {item.thread.isUnread && (
                <span
                  aria-label="Unread"
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
              )}
              <span className={action ? "group-hover/row:opacity-0" : undefined}>
                <StatusSlot item={item} now={now} />
              </span>
              {action && (
                <button
                  type="button"
                  className="pointer-events-auto absolute right-0 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-sidebar-accent px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100"
                  {...isolatedRowGestureProps}
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
        </div>
      </RowContextMenu>
      {expanded && item.children.length > 0 && (
        <ul className="flex flex-col gap-1">
          {item.children.map((child) => (
            <SidebarRow
              key={child.thread.id}
              item={child}
              projectNames={projectNames}
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
