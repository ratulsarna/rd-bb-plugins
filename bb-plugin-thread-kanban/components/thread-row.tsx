import { statusLabelForItem, type BoardItem, type Lane } from "@/lib/lanes";

const LANE_DOT: Record<Lane, string> = {
  "needs-you": "bg-attention",
  running: "bg-success",
  idle: "bg-muted-foreground/50",
};

function titleOf(item: BoardItem): string {
  return item.thread.title ?? item.thread.titleFallback ?? "Untitled thread";
}

function formatRelative(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

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
}

export function ThreadRow({
  item,
  projectName,
  now,
  depth = 0,
  expandedIds,
  onToggleExpanded,
  onOpen,
}: ThreadRowProps) {
  const title = titleOf(item);
  const expanded = expandedIds.has(item.thread.id);
  const branch = item.thread.environment?.branchName;
  const machine = item.thread.host?.name ?? "Machine unavailable";
  const statusLabel = statusLabelForItem(item);

  return (
    <div>
      <div
        className="group flex min-w-0 items-center gap-2 px-3 py-2.5 hover:bg-foreground/[0.035]"
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
        <span
          className={`size-2 shrink-0 rounded-full ${LANE_DOT[item.lane]}`}
          role={statusLabel ? "img" : undefined}
          aria-label={statusLabel}
          aria-hidden={statusLabel ? undefined : true}
        />
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onClick={() => onOpen(item.thread.id)}
          aria-label={`Open ${title}`}
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
            {item.thread.isPinned && (
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Pinned
              </span>
            )}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <MetadataTag label="Project" value={projectName} />
            <MetadataTag label="Machine" value={machine} />
            {branch && <span className="max-w-48 truncate">{branch}</span>}
            <span className="shrink-0 tabular-nums">
              {formatRelative(item.latestActivityAt, now)}
            </span>
          </span>
        </button>
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
      </div>
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
          />
        ))}
    </div>
  );
}
