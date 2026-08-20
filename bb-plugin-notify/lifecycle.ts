const RUN_EVENT_TYPES = [
  "client/turn/requested",
  "turn/started",
  "system/thread/interrupted",
] as const;

interface ThreadEvent {
  seq: number;
  type: string;
  data: unknown;
}

interface ListThreadEventsArgs {
  limit: string;
  order: "desc";
  types: typeof RUN_EVENT_TYPES;
}

type ListThreadEvents = (args: ListThreadEventsArgs) => Promise<ThreadEvent[]>;

function interruptionReason(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const reason = (data as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * Read the newest run boundary and identify how that run ended.
 *
 * The curated `thread.idle` plugin event does not include an idle reason. The
 * durable `system/thread/interrupted` event does, so it is the source of truth.
 * Comparing it with the latest turn request or start prevents an old manual
 * stop from suppressing a later run that completed normally.
 */
export async function latestRunWasManuallyStopped(listEvents: ListThreadEvents): Promise<boolean> {
  const latest = (
    await listEvents({
      limit: "1",
      order: "desc",
      types: RUN_EVENT_TYPES,
    })
  )[0];
  return (
    latest?.type === "system/thread/interrupted" &&
    interruptionReason(latest.data) === "manual-stop"
  );
}
