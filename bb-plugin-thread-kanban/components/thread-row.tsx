import type { PluginSidebarPullRequest } from "@bb/plugin-sdk/app";
import { PrBadge, StatusSlot } from "@/components/row-parts";
import { RowContextMenu } from "@/components/row-context-menu";
import type { PinnedMove } from "@/lib/pinned-order";
import {
  statusLabelForItem,
  threadDisplayTitle,
  type BoardItem,
} from "@/lib/lanes";

function MetadataTag({ label, value }: { label: string; value: string }) {
  return (
    <span
      className="max-w-44 truncate rounded bg-foreground/5 px-1.5 py-0.5 text-[11px] font-medium text-foreground/75"
      title={`${label}: ${value}`}
    >
      <span className="sr-only">{label}: </span>
      {value}
    </span>
  );
}

interface ThreadRowProps {
  item: BoardItem;
  projectName: string;
  now: number;
  depth?: number;
  expandedIds: ReadonlySet<string>;
  onToggleExpanded: (threadId: string) => void;
  onOpen: (threadId: string) => void;
  pullRequest: PluginSidebarPullRequest | null;
  pullRequests: ReadonlyMap<string, PluginSidebarPullRequest | null>;
  /** Settle / Unsettle, provided by the board for root rows only. */
  action?: { label: string; run: () => void };
  /**
   * Pinned-root reordering. The panel has no drag handle, so the context
   * menu is the whole mechanism here.
   */
  pinnedMove?: PinnedMove;
}

export function ThreadRow({
  item,
  projectName,
  now,
  depth = 0,
  expandedIds,
  onToggleExpanded,
  onOpen,
  pullRequest,
  pullRequests,
  action,
  pinnedMove,
}: ThreadRowProps) {
  const title = threadDisplayTitle(item.thread);
  const expanded = expandedIds.has(item.thread.id);
  const branch = item.thread.environment?.branchName;
  const machine = item.thread.host?.name ?? "Machine unavailable";
  const statusLabel = statusLabelForItem(item);

  return (
    <div>
      <RowContextMenu thread={item.thread} pinnedMove={pinnedMove}>
        <div
          className="group flex min-w-0 items-center gap-2 px-3 py-2.5 hover:bg-foreground/[0.035]"
          style={{ paddingLeft: `${12 + depth * 20}px` }}
        >
          <button
            type="button"
            className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => onOpen(item.thread.id)}
            aria-label={`Open ${title}`}
            title={statusLabel}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {title}
              </span>
              {item.thread.isUnread && (
                <span
                  aria-label="Unread"
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
              )}
              {item.thread.isPinned && depth > 0 && (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Pinned
                </span>
              )}
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <MetadataTag label="Project" value={projectName} />
              <MetadataTag label="Machine" value={machine} />
              {branch && <span className="max-w-48 truncate">{branch}</span>}
              <PrBadge pullRequest={pullRequest} />
            </span>
          </button>
          {action && (
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
              onClick={action.run}
            >
              {action.label}
            </button>
          )}
          {item.children.length > 0 && (
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onToggleExpanded(item.thread.id)}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${item.children.length} subagents`}
            >
              <span aria-hidden>{expanded ? "▾" : "▸"}</span>
              <span className="tabular-nums">{item.children.length}</span>
            </button>
          )}
          <StatusSlot item={item} now={now} />
        </div>
      </RowContextMenu>
      {expanded &&
        item.children.map((child) => (
          <ThreadRow
            key={child.thread.id}
            item={child}
            projectName={projectName}
            now={now}
            depth={depth + 1}
            expandedIds={expandedIds}
            onToggleExpanded={onToggleExpanded}
            onOpen={onOpen}
            pullRequest={pullRequests.get(child.thread.id) ?? null}
            pullRequests={pullRequests}
          />
        ))}
    </div>
  );
}
