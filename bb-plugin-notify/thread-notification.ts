export const THREAD_NOTIFICATION_CHANNEL = "thread-notification-changed";

export interface ThreadNotificationChange {
  threadId: string;
  enabled: boolean;
}

export function isThreadNotificationChange(
  value: unknown,
): value is ThreadNotificationChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Record<string, unknown>;
  return (
    typeof change.threadId === "string" && typeof change.enabled === "boolean"
  );
}
