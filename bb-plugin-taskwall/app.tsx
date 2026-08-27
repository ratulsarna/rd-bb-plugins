import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";

const AUTO_REFRESH_MS = 30_000;
const IST_TIME_ZONE = "Asia/Kolkata";

type Wall = PluginRpcResult<(typeof rpcContract)["getWall"]>;
type WallTask = Wall["today"][number];

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

const TIME_FORMAT = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

function dateFromKey(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00+05:30`);
}

function shortDate(dateKey: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(dateFromKey(dateKey));
}

function displayTime(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function ClockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="size-3">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 4.75V8l2.2 1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="size-3.5">
      <path d="m3.5 8.25 2.75 2.5 6.25-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TimeChip({ time }: { time: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-semibold tabular-nums text-primary">
      <ClockIcon />
      {displayTime(time)}
    </span>
  );
}

function TaskRow({ task, overdue = false }: { task: WallTask; overdue?: boolean }) {
  return (
    <article
      className={`animate-in fade-in-0 slide-in-from-bottom-1 flex items-start gap-3 rounded-xl border px-3.5 py-3 duration-500 ${
        overdue
          ? "border-destructive/25 bg-destructive/[0.045]"
          : "border-border/80 bg-card/50"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 size-4 shrink-0 rounded-[5px] border ${
          overdue ? "border-destructive/60" : "border-muted-foreground/45"
        }`}
      />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium leading-5 text-foreground">
          {task.text}
        </p>
        {overdue && task.dueDate && (
          <p className="mt-1 text-[11px] font-medium text-destructive">
            Due {shortDate(task.dueDate)}
          </p>
        )}
      </div>
      {task.dueTime && <TimeChip time={task.dueTime} />}
    </article>
  );
}

function DoneRow({ task }: { task: WallTask }) {
  return (
    <div className="flex items-start gap-2.5 px-1 py-1.5 text-muted-foreground/70">
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-current">
        <CheckIcon />
      </span>
      <span className="text-sm leading-5 line-through decoration-muted-foreground/50">
        {task.text}
      </span>
    </div>
  );
}

function SectionTitle({
  children,
  count,
  urgent = false,
}: {
  children: React.ReactNode;
  count?: number;
  urgent?: boolean;
}) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3">
      <h2 className={`${urgent ? "text-lg text-destructive" : "text-[15px] text-foreground"} font-semibold tracking-tight`}>
        {children}
      </h2>
      {count !== undefined && (
        <span className={`text-[11px] font-semibold tabular-nums ${urgent ? "text-destructive" : "text-muted-foreground"}`}>
          {count}
        </span>
      )}
    </div>
  );
}

function EmptyToday() {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center">
      <p className="text-sm font-medium text-foreground">Nothing due</p>
      <p className="mt-1 text-xs text-muted-foreground">The desk is clear for today.</p>
    </div>
  );
}

function EmptySection({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 py-1 text-xs text-muted-foreground">{children}</p>
  );
}

function LoadingWall() {
  return (
    <div aria-label="Loading task wall" role="status" className="space-y-7 px-4 py-5">
      {[2, 3, 2].map((rows, section) => (
        <div key={section} className="animate-pulse space-y-2.5">
          <div className="h-4 w-24 rounded bg-muted" />
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="h-14 rounded-xl bg-muted/70" />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading tasks</span>
    </div>
  );
}

function UnavailableWall() {
  return (
    <div role="status" className="flex min-h-full flex-col bg-background">
      <div className="flex flex-1 items-center justify-center px-6 py-12 text-center">
        <div>
          <p className="text-sm font-semibold text-foreground">Could not refresh Taskwall.</p>
          <p className="mt-1 text-xs text-muted-foreground">Trying again every 30 seconds.</p>
        </div>
      </div>
      <footer className="border-t border-border/70 px-4 py-3 text-[10px] text-muted-foreground sm:px-5">
        ledger.json · IST
      </footer>
    </div>
  );
}

function useWall() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Wall | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const wall = await rpc.call("getWall", null);
      if (!mounted.current || id !== requestId.current) return;
      setData(wall);
      setFailed(false);
    } catch {
      if (mounted.current && id === requestId.current) setFailed(true);
    }
  }, [rpc]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    mounted.current = true;
    void loadRef.current();
    const timer = window.setInterval(() => void loadRef.current(), AUTO_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void loadRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { data, failed };
}

export function TaskwallHeader() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex items-center gap-2.5 text-right">
      <span className="text-xs text-muted-foreground">{DATE_FORMAT.format(now)}</span>
      <span className="text-xs font-semibold tabular-nums text-foreground">{TIME_FORMAT.format(now)}</span>
    </div>
  );
}

export function TaskwallPanel() {
  const { data, failed } = useWall();
  if (!data) return failed ? <UnavailableWall /> : <LoadingWall />;

  const notice = failed ? "Refresh failed. Showing the last update." : data.error;

  return (
    <div className="flex min-h-full flex-col bg-background">
      <div className="flex-1 space-y-7 overflow-y-auto px-4 py-5 sm:px-5">
        {notice && (
          <p role="status" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {notice}
          </p>
        )}

        {data.overdue.length > 0 && (
          <section aria-labelledby="taskwall-overdue">
            <SectionTitle count={data.overdue.length} urgent>
              <span id="taskwall-overdue">Overdue</span>
            </SectionTitle>
            <div className="space-y-2.5">
              {data.overdue.map((task) => <TaskRow key={task.id} task={task} overdue />)}
            </div>
          </section>
        )}

        <section aria-labelledby="taskwall-today">
          <SectionTitle count={data.today.length}>
            <span id="taskwall-today">Today</span>
          </SectionTitle>
          {data.today.length > 0 ? (
            <div className="space-y-2.5">
              {data.today.map((task) => <TaskRow key={task.id} task={task} />)}
            </div>
          ) : <EmptyToday />}
        </section>

        <section aria-labelledby="taskwall-upcoming">
          <SectionTitle count={data.upcoming.length}>
            <span id="taskwall-upcoming">Next 7 days</span>
          </SectionTitle>
          {data.upcoming.length > 0 ? (
            <div className="space-y-2.5">
              {data.upcoming.map((task) => (
                <div key={task.id}>
                  <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {task.dueDate ? shortDate(task.dueDate) : ""}
                  </p>
                  <TaskRow task={task} />
                </div>
              ))}
            </div>
          ) : <EmptySection>No dated tasks due this week.</EmptySection>}
        </section>

        <section aria-labelledby="taskwall-done" className="border-t border-border/70 pt-5">
          <SectionTitle count={data.doneToday.length}>
            <span id="taskwall-done" className="text-muted-foreground">Done today</span>
          </SectionTitle>
          {data.doneToday.length > 0 ? (
            <div className="space-y-0.5">
              {data.doneToday.map((task) => <DoneRow key={task.id} task={task} />)}
            </div>
          ) : <EmptySection>Nothing finished yet.</EmptySection>}
        </section>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-border/70 px-4 py-3 text-[10px] text-muted-foreground sm:px-5">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-success" />
          Auto-refresh 30s
        </span>
        <span>ledger.json · IST</span>
      </footer>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "taskwall",
    title: "Taskwall",
    icon: "./assets/icon.svg",
    path: "taskwall",
    component: TaskwallPanel,
    headerContent: TaskwallHeader,
  });
});
