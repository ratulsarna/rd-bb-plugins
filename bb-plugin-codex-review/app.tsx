import { useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ReviewTarget, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

type Review = {
  status: "starting" | "running" | "exited" | "disconnected";
  exitCode: number | null;
  output: string;
};

function ReviewButton({
  isCompactViewport,
}: {
  threadId: string;
  isCompactViewport: boolean;
}) {
  const navigate = useBbNavigate();

  return (
    <Button
      type="button"
      variant="ghost"
      size={isCompactViewport ? "icon" : "sm"}
      className={isCompactViewport ? "size-7" : "h-7 px-2 text-xs"}
      aria-label="Open Codex Review"
      onClick={() => {
        const opened = navigate.openThreadPanel({
          actionId: "review-results",
          title: "Codex Review",
        });
        if (!opened) toast.error("This view has no thread side panel.");
      }}
    >
      {isCompactViewport ? (
        <Icon name="FileDiff" className="size-4" aria-hidden="true" />
      ) : (
        "Review"
      )}
    </Button>
  );
}

function ReviewPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [targetKind, setTargetKind] = useState<ReviewTarget["kind"]>("uncommitted");
  const [targetValue, setTargetValue] = useState("");
  const [restoring, setRestoring] = useState(true);
  const [starting, setStarting] = useState(false);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startReview() {
    const value = targetValue.trim();
    const target: ReviewTarget = targetKind === "uncommitted"
      ? { kind: "uncommitted" }
      : targetKind === "base"
        ? { kind: "base", branch: value }
        : { kind: "commit", sha: value };

    setStarting(true);
    setTerminalId(null);
    setReview(null);
    setError(null);
    try {
      const started = await rpc.call("startReview", {
        threadId,
        runId: crypto.randomUUID(),
        target,
      });
      setTerminalId(started.terminalId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start review");
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setRestoring(true);
    setError(null);
    void rpc
      .call("getLatestReview", { threadId })
      .then(({ terminalId: latestTerminalId }) => {
        if (!cancelled) setTerminalId(latestTerminalId);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not restore review");
        }
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  useEffect(() => {
    if (!terminalId) return;
    const reviewTerminalId = terminalId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      try {
        const next = await rpc.call("getReview", {
          threadId,
          terminalId: reviewTerminalId,
        });
        if (cancelled) return;
        setReview(next);
        setError(null);
        if (next.status === "starting" || next.status === "running") {
          timer = setTimeout(() => void refresh(), 1_000);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load review");
          timer = setTimeout(() => void refresh(), 1_500);
        }
      }
    }

    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [rpc, terminalId, threadId]);

  const running =
    !!terminalId &&
    (!review || review.status === "starting" || review.status === "running");
  const busy = restoring || starting || running;
  const statusLabel = error
    ? "Review unavailable"
    : restoring
      ? "Loading latest review"
    : busy
      ? terminalId
        ? "Reviewing changes"
        : "Starting Codex Review"
    : review?.exitCode === 0
      ? "Review complete"
      : review?.status === "disconnected"
        ? "Review disconnected"
        : review?.exitCode === null
          ? "Review stopped"
          : `Review failed (exit ${review?.exitCode})`;

  return (
    <div className="space-y-4">
      <form
        className="space-y-3 rounded-md border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void startReview();
        }}
      >
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Review target</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={targetKind}
            disabled={busy}
            onChange={(event) => {
              setTargetKind(event.target.value as ReviewTarget["kind"]);
              setTargetValue("");
            }}
          >
            <option value="uncommitted">Uncommitted changes</option>
            <option value="base">Changes against a base branch</option>
            <option value="commit">One commit</option>
          </select>
        </label>

        {targetKind !== "uncommitted" && (
          <label className="block space-y-1 text-sm">
            <span className="font-medium">
              {targetKind === "base" ? "Base branch" : "Commit SHA"}
            </span>
            <input
              className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground"
              value={targetValue}
              disabled={busy}
              placeholder={targetKind === "base" ? "main" : "abc1234"}
              onChange={(event) => setTargetValue(event.target.value)}
            />
          </label>
        )}

        <Button
          type="submit"
          size="sm"
          disabled={busy || (targetKind !== "uncommitted" && !targetValue.trim())}
        >
          {busy ? "Reviewing…" : "Run review"}
        </Button>
      </form>

      {(busy || terminalId || review || error) && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              {busy && <Icon name="Spinner" className="animate-spin" aria-hidden="true" />}
              <span className="font-medium">{statusLabel}</span>
            </div>
            {running && terminalId && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void rpc
                    .call("stopReview", { threadId, terminalId })
                    .catch((cause) =>
                      toast.error(cause instanceof Error ? cause.message : "Could not stop review"),
                    );
                }}
              >
                Stop
              </Button>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {(!error || terminalId) && (
            <pre className="min-h-32 whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-xs text-foreground">
              {review?.output || (restoring
                ? "Loading latest review…"
                : busy
                  ? "Codex is starting…"
                  : "No output received.")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "codex-review",
    title: "Codex Review",
    component: ReviewButton,
  });
  app.slots.threadPanelAction({
    id: "review-results",
    title: "Codex Review",
    icon: "FileDiff",
    component: ReviewPanel,
    run: ({ openPanel }) =>
      openPanel({
        title: "Codex Review",
      }),
  });
});
