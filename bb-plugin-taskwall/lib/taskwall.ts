import { z } from "zod";

export const IST_TIME_ZONE = "Asia/Kolkata";

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isDateKey(value: string): boolean {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const ledgerTaskSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    dueDate: z.string().refine(isDateKey).nullable().optional(),
    dueTime: z.string().regex(TIME_PATTERN).nullable().optional(),
    status: z.enum(["open", "done"]),
    createdAt: z.string(),
    doneAt: z.string().nullable().optional(),
  })
  .transform((task) => ({
    ...task,
    dueDate: task.dueDate ?? null,
    dueTime: task.dueTime ?? null,
    doneAt: task.doneAt ?? null,
  }));

export type TaskwallTask = z.output<typeof ledgerTaskSchema>;

export type TaskwallGroups = {
  overdue: TaskwallTask[];
  today: TaskwallTask[];
  upcoming: TaskwallTask[];
  doneToday: TaskwallTask[];
};

export type TaskwallSnapshot = TaskwallGroups & {
  todayKey: string;
  refreshedAt: string;
  skippedCount: number;
  error: string | null;
};

export function istDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function addCalendarDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function parseLedger(content: string): {
  tasks: TaskwallTask[];
  skippedCount: number;
} {
  const input: unknown = JSON.parse(content);
  if (!Array.isArray(input)) throw new Error("Ledger must be a JSON array.");

  const tasks: TaskwallTask[] = [];
  let skippedCount = 0;
  for (const row of input) {
    const result = ledgerTaskSchema.safeParse(row);
    if (result.success) tasks.push(result.data);
    else skippedCount += 1;
  }
  return { tasks, skippedCount };
}

function taskTime(task: TaskwallTask): string {
  return task.dueTime ?? "99:99";
}

function compareDue(a: TaskwallTask, b: TaskwallTask): number {
  const byDate = (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
  if (byDate !== 0) return byDate;
  const byTime = taskTime(a).localeCompare(taskTime(b));
  if (byTime !== 0) return byTime;
  return a.createdAt.localeCompare(b.createdAt);
}

function wasDoneToday(task: TaskwallTask, todayKey: string): boolean {
  if (task.doneAt) {
    const date = new Date(task.doneAt);
    if (Number.isFinite(date.getTime())) return istDateKey(date) === todayKey;
  }
  return task.dueDate === todayKey;
}

export function groupTasks(
  tasks: TaskwallTask[],
  now: Date = new Date(),
): TaskwallGroups & { todayKey: string } {
  const todayKey = istDateKey(now);
  const lastUpcomingKey = addCalendarDays(todayKey, 7);
  const groups: TaskwallGroups = {
    overdue: [],
    today: [],
    upcoming: [],
    doneToday: [],
  };

  for (const task of tasks) {
    if (task.status === "done") {
      if (wasDoneToday(task, todayKey)) groups.doneToday.push(task);
      continue;
    }
    if (!task.dueDate) continue;
    if (task.dueDate < todayKey) groups.overdue.push(task);
    else if (task.dueDate === todayKey) groups.today.push(task);
    else if (task.dueDate <= lastUpcomingKey) groups.upcoming.push(task);
  }

  groups.overdue.sort(compareDue);
  groups.today.sort(compareDue);
  groups.upcoming.sort(compareDue);
  groups.doneToday.sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  return { ...groups, todayKey };
}

export function emptySnapshot(now: Date, error: string | null): TaskwallSnapshot {
  return {
    overdue: [],
    today: [],
    upcoming: [],
    doneToday: [],
    todayKey: istDateKey(now),
    refreshedAt: now.toISOString(),
    skippedCount: 0,
    error,
  };
}
