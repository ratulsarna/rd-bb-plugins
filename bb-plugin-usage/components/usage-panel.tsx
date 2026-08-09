import { useEffect, useState } from "react";
import type { ProviderUsage, UsageWindow } from "./use-usage";
import { useUsage } from "./use-usage";

const PROVIDER_MARKS: Record<ProviderUsage["id"], string> = {
  codex: "CX",
  claudeCode: "CL",
};

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    value,
  );
}

function expectedRemaining(window: UsageWindow): number | null {
  if (!window.pace) return null;
  if (window.pace.kind === "deficit") {
    return clampPercent(window.remainingPercent + window.pace.percentage);
  }
  if (window.pace.kind === "reserve") {
    return clampPercent(window.remainingPercent - window.pace.percentage);
  }
  return clampPercent(window.remainingPercent);
}

function relativeReset(resetsAt: string, now: number): string {
  const target = new Date(resetsAt).getTime();
  if (!Number.isFinite(target)) return "reset time unknown";

  const minutes = Math.ceil((target - now) / 60_000);
  if (minutes <= 0) return "reset due";
  if (minutes < 60) return `resets in ${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return `resets in ${hours}h${restMinutes ? ` ${restMinutes}m` : ""}`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `resets in ${days}d${restHours ? ` ${restHours}h` : ""}`;
}

function paceText(pace: NonNullable<UsageWindow["pace"]>): string {
  if (pace.kind === "deficit") {
    return `+${formatPercent(pace.percentage)}% deficit`;
  }
  if (pace.kind === "reserve") {
    return `${formatPercent(pace.percentage)}% reserve`;
  }
  return "On pace";
}

function paceTone(pace: NonNullable<UsageWindow["pace"]>): string {
  if (pace.kind === "deficit") return "text-destructive";
  if (pace.kind === "reserve") return "text-primary";
  return "text-muted-foreground";
}

function markerTone(pace: NonNullable<UsageWindow["pace"]>): string {
  if (pace.kind === "deficit") return "bg-destructive";
  if (pace.kind === "reserve") return "bg-primary";
  return "bg-muted-foreground";
}

function UsageRow({
  providerName,
  window,
  now,
}: {
  providerName: string;
  window: UsageWindow;
  now: number;
}) {
  const remaining = clampPercent(window.remainingPercent);
  const expected = expectedRemaining(window);

  return (
    <section>
      <div className="flex items-end justify-between gap-4">
        <h3 className="text-sm font-medium text-foreground">
          {window.label}
        </h3>
        <p className="shrink-0 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
          {formatPercent(window.remainingPercent)}% left
        </p>
      </div>

      <div
        role="progressbar"
        aria-label={`${providerName} ${window.label} usage remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
        className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-muted"
      >
        <span
          data-usage-fill=""
          aria-hidden="true"
          className="block h-full rounded-full bg-primary"
          style={{ width: `${remaining}%` }}
        />
        {window.pace && expected !== null && (
          <span
            data-expected-remaining=""
            aria-hidden="true"
            className={`absolute inset-y-0 w-0.5 -translate-x-1/2 ${markerTone(window.pace)}`}
            style={{ left: `${expected}%` }}
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-xs">
        <div>
          {window.resetsAt ? (
            <span className="text-muted-foreground">
              {relativeReset(window.resetsAt, now)}
            </span>
          ) : (
            <span className="text-muted-foreground">Reset time unavailable</span>
          )}
        </div>
        {window.pace && (
          <p className={`font-medium ${paceTone(window.pace)}`}>
            {paceText(window.pace)}
          </p>
        )}
      </div>
    </section>
  );
}

const STATUS_COPY: Record<
  Exclude<ProviderUsage["status"], "ok">,
  (name: string) => string
> = {
  not_installed: (name) => `${name} isn’t installed. Install it to see usage.`,
  unauthenticated: (name) => `Sign in to ${name} to see usage.`,
  expired: (name) => `${name} sign-in expired. Sign in again.`,
  error: (name) => `Couldn’t read ${name} usage right now. Try refresh.`,
};

function ProviderColumn({
  provider,
  now,
  second,
}: {
  provider: ProviderUsage;
  now: number;
  second?: boolean;
}) {
  return (
    <article
      aria-labelledby={`${provider.id}-name`}
      className={
        second
          ? "border-t border-border pt-8 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0"
          : ""
      }
    >
      <header className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted/40 text-xs font-semibold text-foreground"
        >
          {PROVIDER_MARKS[provider.id]}
        </span>
        <div className="min-w-0">
          <h2 id={`${provider.id}-name`} className="font-semibold text-foreground">
            {provider.name}
          </h2>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {provider.accountEmail ?? "Account email unavailable"}
            <span className="mx-1.5 text-border" aria-hidden="true">
              ·
            </span>
            <span className="text-foreground/80">
              {provider.planLabel ?? "Plan unavailable"}
            </span>
          </p>
        </div>
      </header>

      {provider.status === "ok" ? (
        provider.windows.length ? (
          <div className="mt-8 space-y-8">
            {provider.windows.map((window, index) => (
              <UsageRow
                key={`${window.label}-${index}`}
                providerName={provider.name}
                window={window}
                now={now}
              />
            ))}
          </div>
        ) : (
          <p className="mt-8 text-sm text-muted-foreground">
            No usage windows were returned.
          </p>
        )
      ) : (
        <p className="mt-8 max-w-sm text-sm text-muted-foreground">
          {STATUS_COPY[provider.status](provider.name)}
        </p>
      )}
    </article>
  );
}

function UsageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading usage"
      className="grid gap-8 lg:grid-cols-2 lg:gap-10"
    >
      {[0, 1].map((column) => (
        <div
          key={column}
          className={
            column
              ? "border-t border-border pt-8 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0"
              : ""
          }
        >
          <div className="flex animate-pulse items-center gap-3">
            <div className="size-9 rounded-lg bg-muted" />
            <div className="space-y-2">
              <div className="h-4 w-24 rounded bg-muted" />
              <div className="h-3 w-40 rounded bg-muted" />
            </div>
          </div>
          <div className="mt-8 space-y-8">
            {[0, 1].map((row) => (
              <div key={row} className="animate-pulse space-y-3">
                <div className="h-6 w-32 rounded bg-muted" />
                <div className="h-2.5 rounded-full bg-muted" />
                <div className="h-3 w-48 rounded bg-muted" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">Loading subscription usage…</span>
    </div>
  );
}

export function UsagePanel() {
  const { state } = useUsage({ realtime: true });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="h-full overflow-y-auto px-4 py-8 md:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-6xl">
        {state.phase === "loading" && <UsageSkeleton />}
        {state.phase === "error" && (
          <div role="alert" className="py-12 text-center">
            <p className="font-medium text-foreground">Couldn’t load usage.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Try Refresh in the header.
            </p>
          </div>
        )}
        {state.phase === "ready" && (
          <div className="grid gap-8 lg:grid-cols-2 lg:gap-10">
            <ProviderColumn provider={state.data.providers.codex} now={now} />
            <ProviderColumn
              provider={state.data.providers.claudeCode}
              now={now}
              second
            />
          </div>
        )}
      </div>
    </div>
  );
}
