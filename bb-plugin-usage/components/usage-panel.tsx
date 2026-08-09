import { useEffect, useState } from "react";
import { PROVIDER_ACCENT, ProviderMark } from "./provider-mark";
import type { ProviderUsage, UsageWindow } from "./use-usage";
import { useUsage } from "./use-usage";

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
  if (pace.kind === "deficit") return "bg-rose-500/12 text-rose-400";
  if (pace.kind === "reserve") return "bg-emerald-500/12 text-emerald-400";
  return "bg-foreground/[0.07] text-muted-foreground";
}

function markerTone(pace: NonNullable<UsageWindow["pace"]>): string {
  if (pace.kind === "deficit") return "bg-rose-400";
  if (pace.kind === "reserve") return "bg-emerald-400";
  return "bg-foreground/40";
}

function UsageRow({
  providerName,
  accent,
  window,
  now,
}: {
  providerName: string;
  accent: string;
  window: UsageWindow;
  now: number;
}) {
  const remaining = clampPercent(window.remainingPercent);
  const expected = expectedRemaining(window);

  return (
    <section className="px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate text-[13px] font-medium text-muted-foreground">
          {window.label}
        </h3>
        <p className="shrink-0 leading-none tabular-nums">
          <span className="text-[21px] font-semibold tracking-tight text-foreground">
            {formatPercent(window.remainingPercent)}
          </span>
          <span className="ml-0.5 text-xs font-medium text-muted-foreground">
            % left
          </span>
        </p>
      </div>

      <div
        role="progressbar"
        aria-label={`${providerName} ${window.label} usage remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
        className="relative mt-3 h-2 overflow-hidden rounded-full bg-foreground/[0.09]"
      >
        <span
          data-usage-fill=""
          aria-hidden="true"
          className="block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${remaining}%`, backgroundColor: accent }}
        />
        {window.pace && expected !== null && (
          <span
            data-expected-remaining=""
            aria-hidden="true"
            className={`absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full ${markerTone(window.pace)}`}
            style={{ left: `${expected}%` }}
          />
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 text-[11px]">
        <span className="text-muted-foreground">
          {window.resetsAt
            ? relativeReset(window.resetsAt, now)
            : "Reset time unavailable"}
        </span>
        {window.pace && (
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 font-medium ${paceTone(window.pace)}`}
          >
            {paceText(window.pace)}
          </span>
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

function ProviderCard({
  provider,
  now,
}: {
  provider: ProviderUsage;
  now: number;
}) {
  const accent = PROVIDER_ACCENT[provider.id];

  return (
    <article
      aria-labelledby={`${provider.id}-name`}
      className="overflow-hidden rounded-xl border border-border bg-card/40"
    >
      <header className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-lg"
          style={{ color: accent, backgroundColor: `${accent}1f` }}
        >
          <ProviderMark id={provider.id} />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id={`${provider.id}-name`}
            className="truncate text-sm font-semibold tracking-tight text-foreground"
          >
            {provider.name}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {provider.accountEmail ?? "Account email unavailable"}
          </p>
        </div>
        {provider.planLabel && (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {provider.planLabel}
          </span>
        )}
      </header>

      {provider.status === "ok" ? (
        provider.windows.length ? (
          <div className="divide-y divide-border/60">
            {provider.windows.map((window, index) => (
              <UsageRow
                key={`${window.label}-${index}`}
                providerName={provider.name}
                accent={accent}
                window={window}
                now={now}
              />
            ))}
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No usage windows were returned.
          </p>
        )
      ) : (
        <p className="px-4 py-6 text-sm text-muted-foreground">
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
      className="grid items-start gap-4 lg:grid-cols-2"
    >
      {[0, 1].map((column) => (
        <div
          key={column}
          className="animate-pulse rounded-xl border border-border bg-card/40"
        >
          <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3">
            <div className="size-8 shrink-0 rounded-lg bg-muted" />
            <div className="space-y-1.5">
              <div className="h-3.5 w-24 rounded bg-muted" />
              <div className="h-3 w-36 rounded bg-muted" />
            </div>
          </div>
          <div className="divide-y divide-border/60">
            {[0, 1].map((row) => (
              <div key={row} className="space-y-3 px-4 py-4">
                <div className="h-4 w-28 rounded bg-muted" />
                <div className="h-2 rounded-full bg-muted" />
                <div className="h-2.5 w-40 rounded bg-muted" />
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
    <div className="h-full overflow-y-auto px-4 py-6 md:px-6">
      <div className="mx-auto w-full max-w-4xl">
        {state.phase === "loading" && <UsageSkeleton />}
        {state.phase === "error" && (
          <div
            role="alert"
            className="rounded-xl border border-border bg-card/40 px-4 py-10 text-center"
          >
            <p className="text-sm font-medium text-foreground">
              Couldn’t load usage.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Try Refresh in the header.
            </p>
          </div>
        )}
        {state.phase === "ready" && (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <ProviderCard provider={state.data.providers.codex} now={now} />
            <ProviderCard
              provider={state.data.providers.claudeCode}
              now={now}
            />
          </div>
        )}
      </div>
    </div>
  );
}
