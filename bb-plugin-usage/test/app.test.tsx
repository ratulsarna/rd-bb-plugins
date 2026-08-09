// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../app";
import {
  configureFakeSdk,
  emitRealtime,
  registrations,
  rpcCalls,
  setRealtimeConnectionState,
} from "./sdk-fake";

type Status =
  | "ok"
  | "not_installed"
  | "unauthenticated"
  | "expired"
  | "error";

interface Pace {
  kind: "deficit" | "reserve" | "on_pace";
  percentage: number;
}

interface WindowUsage {
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
  pace: Pace | null;
}

function usage({
  fetchedAt = "2026-08-09T12:00:00.000Z",
  codexStatus = "ok",
  codexRemaining = 25,
  codexPace = { kind: "deficit", percentage: 10 },
  claudeStatus = "ok",
  claudeRemaining = 80,
  claudePace = { kind: "reserve", percentage: 15 },
}: {
  fetchedAt?: string;
  codexStatus?: Status;
  codexRemaining?: number;
  codexPace?: Pace | null;
  claudeStatus?: Status;
  claudeRemaining?: number;
  claudePace?: Pace | null;
} = {}) {
  const provider = (
    id: "codex" | "claudeCode",
    name: "Codex" | "Claude Code",
    status: Status,
    remainingPercent: number,
    pace: Pace | null,
  ) => ({
    id,
    name,
    status,
    accountEmail: status === "ok" ? `${id}@example.com` : null,
    planLabel: status === "ok" ? "Pro" : null,
    windows:
      status === "ok"
        ? ([
            {
              label: "Weekly",
              remainingPercent,
              resetsAt: "2026-08-12T13:00:00.000Z",
              pace,
            },
          ] satisfies WindowUsage[])
        : [],
  });

  return {
    fetchedAt,
    providers: {
      codex: provider("codex", "Codex", codexStatus, codexRemaining, codexPace),
      claudeCode: provider(
        "claudeCode",
        "Claude Code",
        claudeStatus,
        claudeRemaining,
        claudePace,
      ),
    },
  };
}

const panel = registrations.navPanels[0]!;
const Panel = panel.component;

function renderPanel() {
  return render(<Panel subPath="" />);
}

/** The percentage is split across styled spans, so read the accessible value. */
function remaining(provider: "Codex" | "Claude Code" = "Codex") {
  return screen
    .getByRole("progressbar", { name: `${provider} Weekly usage remaining` })
    .getAttribute("aria-valuenow");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usage panel", () => {
  it("fills bars in the remaining direction and exposes progress values", async () => {
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    configureFakeSdk({ getUsage: () => usage() });
    renderPanel();

    const codexBar = await screen.findByRole("progressbar", {
      name: "Codex Weekly usage remaining",
    });
    expect(codexBar.getAttribute("aria-valuemin")).toBe("0");
    expect(codexBar.getAttribute("aria-valuemax")).toBe("100");
    expect(codexBar.getAttribute("aria-valuenow")).toBe("25");
    expect(
      (codexBar.querySelector("[data-usage-fill]") as HTMLElement).style.width,
    ).toBe("25%");
    expect(
      (codexBar.querySelector("[data-expected-remaining]") as HTMLElement).style
        .left,
    ).toBe("35%");

    const claudeBar = screen.getByRole("progressbar", {
      name: "Claude Code Weekly usage remaining",
    });
    expect(
      (claudeBar.querySelector("[data-usage-fill]") as HTMLElement).style.width,
    ).toBe("80%");
    expect(
      (claudeBar.querySelector("[data-expected-remaining]") as HTMLElement).style
        .left,
    ).toBe("65%");
    expect(screen.getByText("+10% deficit")).toBeTruthy();
    expect(screen.getByText("15% reserve")).toBeTruthy();
    expect(screen.getAllByText("resets in 3d 1h")).toHaveLength(2);
    expect(document.querySelector("time")).toBeNull();
  });

  it("keeps a healthy provider usable when the other provider fails", async () => {
    configureFakeSdk({
      getUsage: () => usage({ codexStatus: "error", claudeRemaining: 72 }),
    });
    renderPanel();

    expect(
      await screen.findByText(
        "Couldn’t read Codex usage right now. Try refresh.",
      ),
    ).toBeTruthy();
    const claude = screen
      .getByRole("heading", { name: "Claude Code" })
      .closest("article");
    expect(claude).not.toBeNull();
    expect(
      within(claude as HTMLElement)
        .getByRole("progressbar")
        .getAttribute("aria-valuenow"),
    ).toBe("72");
  });

  it("gives an honest server-local fallback for expired Claude usage", async () => {
    configureFakeSdk({
      getUsage: () => usage({ claudeStatus: "expired" }),
    });
    renderPanel();

    expect(
      await screen.findByText(
        "Claude Code usage session expired. Click Refresh. If that still fails, open Claude Code on this server.",
      ),
    ).toBeTruthy();
  });

  it("ignores a stale response after a realtime refetch finishes", async () => {
    const oldest = deferred<ReturnType<typeof usage>>();
    const newest = deferred<ReturnType<typeof usage>>();
    let call = 0;
    configureFakeSdk({
      getUsage: () => (++call === 1 ? oldest.promise : newest.promise),
    });
    renderPanel();

    await waitFor(() => expect(rpcCalls).toHaveLength(1));
    act(() => emitRealtime("usage-updated"));
    await waitFor(() => expect(rpcCalls).toHaveLength(2));

    await act(async () => newest.resolve(usage({ codexRemaining: 91 })));
    await waitFor(() => expect(remaining()).toBe("91"));

    await act(async () => oldest.resolve(usage({ codexRemaining: 8 })));
    expect(remaining()).toBe("91");
  });

  it("refreshes automatically every 180 seconds while mounted", async () => {
    vi.useFakeTimers();
    configureFakeSdk({ getUsage: () => usage() });
    renderPanel();
    await act(async () => undefined);
    expect(rpcCalls).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(180_000);
    });
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[1]).toEqual({ method: "getUsage", input: {} });
  });

  it("refetches after the realtime connection recovers", async () => {
    configureFakeSdk({ getUsage: () => usage() });
    renderPanel();
    await waitFor(() => expect(rpcCalls).toHaveLength(1));

    act(() => setRealtimeConnectionState("reconnecting"));
    act(() => setRealtimeConnectionState("connected"));

    await waitFor(() => expect(rpcCalls).toHaveLength(2));
    expect(rpcCalls[1]).toEqual({ method: "getUsage", input: {} });
  });

  it("uses a forced refresh and disables the header button while pending", async () => {
    const manual = deferred<ReturnType<typeof usage>>();
    let call = 0;
    configureFakeSdk({
      getUsage: () => (++call === 1 ? usage() : manual.promise),
    });
    const Header = panel.headerContent;
    if (!Header) throw new Error("Usage header was not registered");
    render(<Header subPath="" />);

    const button = await screen.findByRole("button", { name: "Refresh" });
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe("Refreshing…");
    expect(rpcCalls[1]).toEqual({
      method: "getUsage",
      input: { refresh: true },
    });

    await act(async () => manual.resolve(usage({ codexRemaining: 99 })));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.textContent).toBe("Refresh");
  });

  it("updates the open panel after a manual refresh without realtime", async () => {
    configureFakeSdk({
      getUsage: (input) =>
        (input as { refresh?: boolean }).refresh
          ? usage({ codexRemaining: 99 })
          : usage({ codexRemaining: 25 }),
    });
    renderPanel();
    const Header = panel.headerContent;
    if (!Header) throw new Error("Usage header was not registered");
    render(<Header subPath="" />);

    await waitFor(() => expect(remaining()).toBe("25"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(remaining()).toBe("99"));
  });

  it("rejects an old manual response after the panel gets newer data", async () => {
    const manual = deferred<ReturnType<typeof usage>>();
    let ordinaryCalls = 0;
    configureFakeSdk({
      getUsage: (input) => {
        if ((input as { refresh?: boolean }).refresh) return manual.promise;
        ordinaryCalls += 1;
        return ordinaryCalls <= 2
          ? usage({ codexRemaining: 25 })
          : usage({
              fetchedAt: "2026-08-09T12:02:00.000Z",
              codexRemaining: 91,
            });
      },
    });
    renderPanel();
    const Header = panel.headerContent;
    if (!Header) throw new Error("Usage header was not registered");
    render(<Header subPath="" />);

    await waitFor(() => expect(remaining()).toBe("25"));
    await waitFor(() => expect(rpcCalls).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(rpcCalls).toHaveLength(3));

    act(() => emitRealtime("usage-updated"));
    await waitFor(() => expect(remaining()).toBe("91"));

    await act(async () =>
      manual.resolve(
        usage({
          fetchedAt: "2026-08-09T12:01:00.000Z",
          codexRemaining: 50,
        }),
      ),
    );
    expect(remaining()).toBe("91");
  });

  it("clears a manual failure after the next automatic update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    let ordinaryCalls = 0;
    configureFakeSdk({
      getUsage: (input) => {
        if ((input as { refresh?: boolean }).refresh) {
          throw new Error("offline");
        }
        ordinaryCalls += 1;
        return usage({
          fetchedAt:
            ordinaryCalls === 1
              ? "2026-08-09T12:00:00.000Z"
              : "2026-08-09T12:03:00.000Z",
        });
      },
    });
    const Header = panel.headerContent;
    if (!Header) throw new Error("Usage header was not registered");
    render(<Header subPath="" />);

    await act(async () => undefined);
    const button = screen.getByRole("button", { name: "Refresh" });
    await act(async () => fireEvent.click(button));

    expect(screen.getByText(/Update failed/)).toBeTruthy();
    expect(button.textContent).toBe("Refresh");

    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect(screen.queryByText(/Update failed/)).toBeNull();
    expect(screen.getByText("Updated just now")).toBeTruthy();
  });
});
