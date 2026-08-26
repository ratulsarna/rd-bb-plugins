export const THREAD_MUTE_CHANNEL = "thread-mute-changed";

export interface ThreadMuteChange {
  threadId: string;
  muted: boolean;
}

export function isThreadMuteChange(value: unknown): value is ThreadMuteChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Record<string, unknown>;
  return typeof change.threadId === "string" && typeof change.muted === "boolean";
}
