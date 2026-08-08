import type { PluginSidebarPullRequest } from "@bb/plugin-sdk/app";
import { statusLabelForItem, type BoardItem, type PrState } from "@/lib/lanes";

export function formatRelative(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const PR_BADGE: Record<PrState, { text: string; label: string }> = {
  draft: { text: "text-muted-foreground", label: "Draft PR" },
  open: { text: "text-success", label: "Open PR" },
  merged: { text: "text-primary", label: "Merged PR" },
  closed: { text: "text-destructive", label: "Closed PR" },
};

export function PrBadge({
  pullRequest,
}: {
  pullRequest: PluginSidebarPullRequest | null;
}) {
  if (!pullRequest) return null;
  const badge = PR_BADGE[pullRequest.state];
  return (
    <span
      className={`shrink-0 text-xs font-medium tabular-nums ${badge.text}`}
      title={`${badge.label}: ${pullRequest.title}`}
    >
      #{pullRequest.number}
    </span>
  );
}

/** The row's status: position never carries it, this slot does. */
export function StatusSlot({ item, now }: { item: BoardItem; now: number }) {
  const label = statusLabelForItem(item);
  if (item.lane === "needs-you") {
    return (
      <span
        className="shrink-0 rounded-full bg-attention/15 px-2 py-0.5 text-[11px] font-medium text-attention"
        title={label}
      >
        Needs you
      </span>
    );
  }
  if (item.lane === "running") {
    return (
      <span
        className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"
        title={label}
      >
        Running
      </span>
    );
  }
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {formatRelative(item.latestActivityAt, now)}
    </span>
  );
}
