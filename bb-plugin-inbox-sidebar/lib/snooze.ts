const HOUR_MS = 60 * 60 * 1_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export interface SnoozePreset {
  label: string;
  until: number;
}

/** A local wall-clock time `days` from `now`, so DST shifts land on the hour. */
function atLocal(now: Date, days: number, hour: number): number {
  const at = new Date(now);
  at.setDate(at.getDate() + days);
  at.setHours(hour, 0, 0, 0);
  return at.getTime();
}

/** The snooze menu's presets, on the user's local clock. */
export function snoozePresets(now: Date): SnoozePreset[] {
  const ms = now.getTime();
  // From a Monday, "next week" is the Monday after, never today.
  const daysToMonday = (8 - now.getDay()) % 7 || 7;
  return [
    { label: "1 hour", until: ms + HOUR_MS },
    { label: "3 hours", until: ms + 3 * HOUR_MS },
    ...(now.getHours() < EVENING_HOUR
      ? [{ label: "This evening", until: atLocal(now, 0, EVENING_HOUR) }]
      : []),
    { label: "Tomorrow", until: atLocal(now, 1, MORNING_HOUR) },
    { label: "Next week", until: atLocal(now, daysToMonday, MORNING_HOUR) },
  ];
}

/** When a snoozed row comes back, as short as the row's status cell needs. */
export function formatWakeTime(until: number, now: number): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const days = Math.round(
    (atLocal(at, 0, 0) - atLocal(new Date(now), 0, 0)) / (24 * HOUR_MS),
  );
  if (days <= 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) {
    return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
