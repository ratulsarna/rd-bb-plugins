import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import { shouldRefreshOnReconnect } from "@/lib/reconnect";

/**
 * A value read from the plugin: on mount, on every signal on `channel`, and
 * after a reconnect. Reads are best-effort: a failed one keeps the last value.
 * Returns the value and a way to read it again.
 */
export function useLiveRead<T>(
  channel: string,
  read: () => Promise<T>,
  initial: T,
): [T, () => void] {
  const connectionState = useRealtimeConnectionState();
  const [value, setValue] = useState(initial);
  const latestRead = useRef(read);
  latestRead.current = read;

  // Responses can land out of order (a mutation's refresh racing a realtime
  // one); only the newest request may write.
  const requestSeq = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++requestSeq.current;
    latestRead.current().then(
      (next) => {
        if (seq === requestSeq.current) setValue(next);
      },
      () => {},
    );
  }, []);

  useEffect(refresh, [refresh]);

  useRealtime(channel, refresh);

  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (shouldRefreshOnReconnect(previous, connectionState)) refresh();
  }, [connectionState, refresh]);

  return [value, refresh];
}
