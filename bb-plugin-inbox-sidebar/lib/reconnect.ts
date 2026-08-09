import type { PluginRealtimeConnectionState } from "@bb/plugin-sdk/app";

export function shouldRefreshOnReconnect(
  previous: PluginRealtimeConnectionState,
  next: PluginRealtimeConnectionState,
): boolean {
  return previous === "reconnecting" && next === "connected";
}
