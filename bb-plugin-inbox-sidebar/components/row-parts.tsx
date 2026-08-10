import type { PluginSidebarPullRequest } from "@bb/plugin-sdk/app";
import { isolatedRowGestureProps } from "@/components/row-gesture";
import { statusLabelForItem, type BoardItem } from "@/lib/lanes";

export function formatRelative(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const PR_LINK: Partial<
  Record<PluginSidebarPullRequest["state"], { text: string; label: string }>
> = {
  draft: { text: "text-muted-foreground", label: "Draft pull request" },
  open: { text: "text-success", label: "Open pull request" },
};

export function OpenPrLink({
  pullRequest,
}: {
  pullRequest: PluginSidebarPullRequest | null;
}) {
  if (!pullRequest) return null;
  const link = PR_LINK[pullRequest.state];
  if (!link) return null;

  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${link.label} #${pullRequest.number}: ${pullRequest.title}`}
      title={`${link.label} #${pullRequest.number}: ${pullRequest.title}`}
      className={`pointer-events-auto relative inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-sidebar-border px-1 text-[11px] font-medium tabular-nums no-underline hover:border-current hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${link.text}`}
      {...isolatedRowGestureProps}
      onClick={(event) => event.stopPropagation()}
    >
      <svg
        aria-hidden
        className="size-3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        viewBox="0 0 24 24"
      >
        <circle cx="6" cy="18" r="2" />
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="18" r="2" />
        <path d="M6 8v8M16 6h-5M16 6l-3-3M16 6l-3 3M18 16v-5a5 5 0 0 0-5-5" />
      </svg>
      #{pullRequest.number}
    </a>
  );
}

/** The row's status: position never carries it, this slot does. */
export function StatusSlot({ item, now }: { item: BoardItem; now: number }) {
  const label = statusLabelForItem(item);
  if (item.lane === "needs-you") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-attention"
        title={label}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        Needs you
      </span>
    );
  }
  if (item.lane === "running") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-success"
        title={label}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
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
