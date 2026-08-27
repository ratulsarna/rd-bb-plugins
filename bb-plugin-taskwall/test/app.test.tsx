// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../app.tsx";
import { configureFakeSdk, registrations, rpcCalls } from "./sdk-fake.ts";

type Wall = {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  doneToday: Task[];
  todayKey: string;
  refreshedAt: string;
  skippedCount: number;
  error: string | null;
};

type Task = {
  id: string;
  text: string;
  dueDate: string | null;
  dueTime: string | null;
  status: "open" | "done";
  createdAt: string;
  doneAt: string | null;
};

function wall(text: string): Wall {
  return {
    overdue: [],
    today: [
      {
        id: text,
        text,
        dueDate: "2026-08-27",
        dueTime: null,
        status: "open",
        createdAt: "2026-08-27T00:00:00Z",
        doneAt: null,
      },
    ],
    upcoming: [],
    doneToday: [],
    todayKey: "2026-08-27",
    refreshedAt: "2026-08-27T00:00:00.000Z",
    skippedCount: 0,
    error: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const Panel = registrations.navPanels[0]!.component;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Taskwall polling", () => {
  it("shows an initial failure and recovers on the next poll", async () => {
    vi.useFakeTimers();
    let calls = 0;
    configureFakeSdk(() => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return wall("Recovered task");
    });

    render(<Panel subPath="" />);
    await act(async () => undefined);

    expect(screen.getByText("Could not refresh Taskwall.")).toBeTruthy();
    expect(screen.queryByLabelText("Loading task wall")).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByText("Recovered task")).toBeTruthy();
    expect(document.querySelector("main")).toBeNull();
  });

  it("ignores an older poll response that finishes last", async () => {
    vi.useFakeTimers();
    const older = deferred<Wall>();
    const newer = deferred<Wall>();
    let calls = 0;
    configureFakeSdk(() => (++calls === 1 ? older.promise : newer.promise));

    render(<Panel subPath="" />);
    await act(async () => undefined);
    expect(rpcCalls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(rpcCalls).toHaveLength(2);

    await act(async () => newer.resolve(wall("New task")));
    expect(screen.getByText("New task")).toBeTruthy();

    await act(async () => older.resolve(wall("Old task")));
    expect(screen.getByText("New task")).toBeTruthy();
    expect(screen.queryByText("Old task")).toBeNull();
  });
});
