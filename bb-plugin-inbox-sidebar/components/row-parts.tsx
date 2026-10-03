import type { PipelinePullRequest } from "@/server";
import { isolatedRowGestureProps } from "@/components/row-gesture";
import { formatWakeTime } from "@/lib/snooze";
import {
  rowStatusForItem,
  statusLabelForItem,
  type BoardItem,
  type RowStatus,
} from "@/lib/lanes";

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
  Record<PipelinePullRequest["state"], { text: string; label: string }>
> = {
  draft: { text: "text-muted-foreground", label: "Draft pull request" },
  open: { text: "text-success", label: "Open pull request" },
};

export function OpenPrLink({
  pullRequest,
}: {
  pullRequest: PipelinePullRequest | null;
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

// Time ago shows only where there is no live state to report.
const STATUS_DOT: Record<RowStatus, { tone: string | null; showsTime: boolean }> =
  {
    "needs-you": { tone: "text-attention", showsTime: false },
    failed: { tone: "text-destructive", showsTime: false },
    woken: { tone: "text-sky-500", showsTime: false },
    running: { tone: "text-success", showsTime: false },
    done: { tone: "text-primary", showsTime: true },
    idle: { tone: null, showsTime: true },
  };

/**
 * The row's status: position never carries it, this slot does. The dot has no
 * tooltip of its own because the row's anchor shows the same label on hover.
 */
export function StatusSlot({
  item,
  now,
  wakeAt,
}: {
  item: BoardItem;
  now: number;
  /** A snoozed row shows when it comes back in place of its age. */
  wakeAt?: number;
}) {
  const { tone, showsTime } = STATUS_DOT[rowStatusForItem(item)];
  const time =
    wakeAt !== undefined
      ? formatWakeTime(wakeAt, now)
      : showsTime
        ? formatRelative(item.latestActivityAt, now)
        : null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {tone && (
        <span
          role="img"
          aria-label={statusLabelForItem(item)}
          className={`size-1.5 shrink-0 rounded-full bg-current ${tone}`}
        />
      )}
      {time && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {time}
        </span>
      )}
    </span>
  );
}
