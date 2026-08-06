// The one reusable Subagent Dashboard, rendered by both the "Subagents" nav
// panel (project scope) and the per-thread "Subagents" panel tab (direct
// children of one thread). Durable state comes from the `dashboard` RPC;
// realtime "threads-changed" signals only trigger a reconciling refetch.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { PluginRpcResult } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

type Dashboard = PluginRpcResult<(typeof rpcContract)["dashboard"]>;
type Subagent = Dashboard["subagents"][number];
type SendMode = "steer" | "queue";

type Scope = {
  projectId: string | null;
  parentThreadId: string | null;
};

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; data: Dashboard };

// Mirrors the server's status buckets so tone matches the backend counts.
const ACTIVE_STATUSES = ["active", "starting", "provisioning", "stopping"];
const ATTENTION_STATUSES = ["error", "host-reconnecting", "waiting-for-host"];

type Tone = "active" | "idle" | "attention" | "neutral";

const isActive = (s: Subagent) => ACTIVE_STATUSES.includes(s.status);

function toneOf(s: Subagent): Tone {
  if (s.hasPendingInteraction || ATTENTION_STATUSES.includes(s.status)) {
    return "attention";
  }
  if (isActive(s)) return "active";
  if (s.status === "idle") return "idle";
  return "neutral";
}

const DOT_TONE: Record<Tone, string> = {
  active: "bg-primary",
  idle: "bg-muted-foreground",
  attention: "bg-destructive",
  neutral: "bg-muted-foreground/40",
};

function prettyStatus(status: string): string {
  const spaced = status.replace(/[-_]/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Unknown";
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 45_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(ts).toLocaleDateString();
}

function scopeMessage(scope: Scope): string {
  if (scope.parentThreadId) return "under this thread";
  return scope.projectId ? "in this project" : "across bb";
}

/**
 * Loads the dashboard for a scope and keeps it reconciled. Realtime signals are
 * debounced into a single refetch, and a reconnect (reconnecting → connected)
 * forces one too, since ephemeral signals can be missed while disconnected.
 */
function useDashboard(scope: Scope): {
  state: LoadState;
  reload: () => void;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const mounted = useRef(true);
  const reqId = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = useCallback(async () => {
    const id = ++reqId.current;
    // Keep any existing list visible during a refetch — don't flash loading.
    setState((prev) => (prev.phase === "ready" ? prev : { phase: "loading" }));
    const { projectId, parentThreadId } = scopeRef.current;
    try {
      const data = await rpc.call("dashboard", { projectId, parentThreadId });
      if (mounted.current && id === reqId.current) {
        setState({ phase: "ready", data });
      }
    } catch (err) {
      if (!mounted.current || id !== reqId.current) return;
      const message =
        err instanceof Error ? err.message : "Failed to load subagents.";
      // A refetch failure keeps the last good list rather than blanking it.
      setState((prev) =>
        prev.phase === "ready" ? prev : { phase: "error", message },
      );
    }
  }, [rpc]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reload whenever the scope changes.
  useEffect(() => {
    void load();
  }, [load, scope.projectId, scope.parentThreadId]);

  // Coalesce bursts of lifecycle signals into one refetch.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (debounce.current !== null) return;
    debounce.current = setTimeout(() => {
      debounce.current = null;
      void loadRef.current();
    }, 250);
  }, []);

  useEffect(
    () => () => {
      if (debounce.current !== null) clearTimeout(debounce.current);
    },
    [],
  );

  const handleSignal = useCallback(
    (payload: unknown) => {
      const signal = payload as {
        projectId?: string | null;
        parentThreadId?: string | null;
      } | null;
      const { projectId, parentThreadId } = scopeRef.current;
      const relevant = parentThreadId
        ? signal?.parentThreadId === parentThreadId
        : projectId
          ? signal?.projectId === projectId
          : true;
      if (relevant) scheduleReload();
    },
    [scheduleReload],
  );
  useRealtime("threads-changed", handleSignal);

  // Reconcile after a dropped connection recovers.
  const connection = useRealtimeConnectionState();
  const prevConnection = useRef(connection);
  useEffect(() => {
    if (prevConnection.current === "reconnecting" && connection === "connected") {
      void loadRef.current();
    }
    prevConnection.current = connection;
  }, [connection]);

  return { state, reload: () => void load() };
}

function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        DOT_TONE[tone],
        tone === "active" && "animate-pulse",
        className,
      )}
    />
  );
}

function Meta({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Icon name={icon} aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

function SummaryBar({
  counts,
  connection,
  onReload,
}: {
  counts: Dashboard["counts"];
  connection: ReturnType<typeof useRealtimeConnectionState>;
  onReload: () => void;
}) {
  const Count = ({
    tone,
    label,
    value,
  }: {
    tone: Tone;
    label: string;
    value: number;
  }) => (
    <span className="inline-flex items-center gap-1.5">
      <Dot tone={tone} />
      <span className="font-medium tabular-nums text-foreground">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Count tone="active" label="active" value={counts.active} />
        <Count tone="idle" label="idle" value={counts.idle} />
        <Count tone="attention" label="attention" value={counts.attention} />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {connection !== "connected" && (
          <span className="inline-flex items-center gap-1">
            <Icon name="Loading" aria-hidden className="size-3 animate-spin" />
            reconnecting
          </span>
        )}
        <span className="tabular-nums">{counts.total} total</span>
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0"
          onClick={onReload}
          aria-label="Refresh subagents"
        >
          <Icon name="RotateCcw" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function SubagentRow({
  subagent,
  onOpen,
  onStop,
  onSend,
}: {
  subagent: Subagent;
  onOpen: () => void;
  onStop: () => Promise<void>;
  onSend: (message: string, mode: SendMode) => Promise<void>;
}) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "stop" | "send">(null);
  const [error, setError] = useState<string | null>(null);

  const tone = toneOf(subagent);
  const active = isActive(subagent);

  const fail = (err: unknown) =>
    setError(err instanceof Error ? err.message : "Something went wrong.");

  const handleStop = async () => {
    setBusy("stop");
    setError(null);
    try {
      await onStop();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const handleSend = async (mode: SendMode) => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy("send");
    setError(null);
    try {
      await onSend(message, mode);
      setText("");
      setComposerOpen(false);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <Dot tone={tone} />
            <span className="truncate text-sm font-medium text-foreground">
              {subagent.title}
            </span>
            {subagent.visibility === "hidden" && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-foreground/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                <Icon name="EyeOff" aria-hidden className="size-3" />
                Hidden
              </span>
            )}
            {subagent.hasPendingInteraction && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                <Icon name="MessageQuestion" aria-hidden className="size-3" />
                Awaiting input
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="rounded bg-foreground/5 px-1.5 py-0.5 font-medium text-foreground/80">
              {subagent.providerId}
            </span>
            <span
              className={cn(tone === "attention" && "font-medium text-destructive")}
            >
              {prettyStatus(subagent.status)}
            </span>
            {subagent.environmentName && (
              <Meta icon="Container">{subagent.environmentName}</Meta>
            )}
            {subagent.branchName && (
              <Meta icon="GitBranch">{subagent.branchName}</Meta>
            )}
            <Meta icon="Clock">{formatRelative(subagent.updatedAt)}</Meta>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0"
            onClick={onOpen}
            aria-label="Open thread"
          >
            <Icon name="ExternalLink" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0"
            aria-label="Send a follow-up"
            aria-pressed={composerOpen}
            onClick={() => setComposerOpen((open) => !open)}
          >
            <Icon name="MessageSquare" aria-hidden />
          </Button>
          {active && (
            <Button
              variant="ghost"
              size="sm"
              className="size-8 p-0 text-muted-foreground hover:text-destructive"
              onClick={handleStop}
              disabled={busy !== null}
              aria-label="Stop subagent"
            >
              <Icon name="Square" aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {composerOpen && (
        <div className="mt-2.5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSend(active ? "steer" : "queue");
                }
              }}
              placeholder="Send a follow-up…"
              disabled={busy === "send"}
              className="h-8 min-w-0 flex-1 text-sm"
            />
            <Button
              size="sm"
              onClick={() => void handleSend("steer")}
              disabled={busy !== null || text.trim() === ""}
            >
              Steer
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleSend("queue")}
              disabled={busy !== null || text.trim() === ""}
            >
              Queue
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Steer interrupts now · Queue runs after the current turn.
          </p>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </Card>
  );
}

function EmptyState({ scope }: { scope: Scope }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <Icon name="Workflow" aria-hidden className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">
        No subagents {scopeMessage(scope)}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Subagents spawned {scopeMessage(scope)} will appear here as they start.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <Card key={i} className="p-3">
          <div className="animate-pulse space-y-2">
            <div className="h-4 w-1/3 rounded bg-foreground/10" />
            <div className="h-3 w-2/3 rounded bg-foreground/5" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card className="border-destructive/40 p-4">
      <div className="flex items-start gap-3">
        <Icon
          name="AlertTriangle"
          aria-hidden
          className="size-5 shrink-0 text-destructive"
        />
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            Couldn’t load subagents
          </p>
          <p className="break-words text-xs text-muted-foreground">{message}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * The dashboard body. Layout is container-agnostic (max width plus wrapping)
 * so it reads well both in the wide nav panel and the narrow thread side panel.
 */
export function SubagentDashboard(scope: Scope) {
  const { state, reload } = useDashboard(scope);
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const navigate = useBbNavigate();

  const stopSubagent = async (threadId: string) => {
    await rpc.call("stopSubagent", { threadId });
    reload();
  };
  const sendMessage = async (
    threadId: string,
    message: string,
    mode: SendMode,
  ) => {
    await rpc.call("messageSubagent", { threadId, message, mode });
    reload();
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {state.phase === "ready" && (
        <SummaryBar
          counts={state.data.counts}
          connection={connection}
          onReload={reload}
        />
      )}

      {state.phase === "loading" && <LoadingState />}
      {state.phase === "error" && (
        <ErrorState message={state.message} onRetry={reload} />
      )}
      {state.phase === "ready" &&
        (state.data.subagents.length === 0 ? (
          <EmptyState scope={scope} />
        ) : (
          <div className="space-y-2">
            {state.data.subagents.map((subagent) => (
              <SubagentRow
                key={subagent.id}
                subagent={subagent}
                onOpen={() => navigate.toThread(subagent.id)}
                onStop={() => stopSubagent(subagent.id)}
                onSend={(message, mode) =>
                  sendMessage(subagent.id, message, mode)
                }
              />
            ))}
          </div>
        ))}
    </div>
  );
}
