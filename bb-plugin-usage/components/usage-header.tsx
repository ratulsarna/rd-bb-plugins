import { useEffect, useState } from "react";
import { useUsage } from "./use-usage";

function relativeUpdated(fetchedAt: string, now: number): string {
  const fetched = new Date(fetchedAt).getTime();
  if (!Number.isFinite(fetched)) return "time unknown";
  const seconds = Math.max(0, Math.floor((now - fetched) / 1_000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function UsageHeader() {
  const { state, manualPending, manualFailed, refresh } = useUsage();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const updated =
    state.phase === "ready"
      ? `Updated ${relativeUpdated(state.data.fetchedAt, now)}`
      : state.phase === "error"
        ? "Update unavailable"
        : "Updating…";

  return (
    <div className="flex items-center gap-3">
      <span
        className="whitespace-nowrap text-xs text-muted-foreground"
        aria-live="polite"
      >
        {manualFailed ? `Update failed · ${updated}` : updated}
      </span>
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={manualPending}
        className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {manualPending ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
