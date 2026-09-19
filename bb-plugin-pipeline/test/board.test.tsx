// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COLUMNS, COLUMN_LABELS } from "../lib/columns";
import { makeCard, makeSidebarThread } from "./sdk-fake";

const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;
const mounted: Array<ReturnType<typeof renderSlot>> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.lifecycle.unmount();
  cleanup();
  localStorage.clear();
});

function renderBoard(options?: {
  cards?: ReturnType<typeof makeCard>[];
  pending?: boolean;
  ownerThreadId?: string;
  connection?: "connecting" | "connected" | "reconnecting";
  listCards?: ReturnType<typeof vi.fn>;
}) {
  const listCards =
    options?.listCards ??
    vi.fn(() => ({ cards: options?.cards ?? [makeCard()] }));
  const slot = renderSlot(
    panel,
    { subPath: "" },
    {
      context: { projectId: "proj_1", threadId: null },
      realtimeConnectionState: options?.connection ?? "connected",
      sidebarThreads: {
        status: "ready",
        projects: [],
        threads: [
          makeSidebarThread({
            id: options?.ownerThreadId ?? "intake",
            hasPendingInteraction: options?.pending ?? false,
          }),
        ],
      },
      rpc: {
        listProjects: () => ({ projects: [{ id: "proj_1", name: "Example" }] }),
        listCards,
        addCard: () => makeCard(),
        moveCard: (input: unknown) => {
          const { cardId, column } = input as { cardId: string; column: string };
          return makeCard({ id: cardId, column: column as never });
        },
        retryLaunch: () => makeCard(),
        removeCard: () => ({ removed: true }),
        showCard: () => ({ card: makeCard(), history: [] }),
      },
    },
  );
  mounted.push(slot);
  return { slot, listCards };
}

describe("pipeline board", () => {
  it("renders columns in order, hides done, and shows the attention reason", async () => {
    renderBoard({
      cards: [
        makeCard({
          title: "Needs a choice",
          needsUser: true,
          attentionReason: "choose the deployment",
        }),
        makeCard({ id: "done", title: "Finished", column: "done" }),
      ],
    });

    await screen.findByText("Needs a choice");
    const regions = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
    expect(regions).toEqual(COLUMNS.filter((column) => column !== "done").map((column) => COLUMN_LABELS[column]));
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
    expect(screen.getByText("choose the deployment")).toBeTruthy();
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("opens the owner thread and marks a pending question", async () => {
    const { slot } = renderBoard({
      pending: true,
      ownerThreadId: "lead",
      cards: [makeCard({ leadThreadId: "lead" })],
    });
    const title = await screen.findByText("A pipeline card");

    fireEvent.click(title.closest("button")!);

    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "lead" });
    expect(screen.getByLabelText("Question open")).toBeTruthy();
  });

  it("refetches when realtime reconnects", async () => {
    const listCards = vi.fn(() => ({ cards: [makeCard()] }));
    const { slot } = renderBoard({ connection: "reconnecting", listCards });
    await screen.findByText("A pipeline card");
    const before = listCards.mock.calls.length;

    await slot.behavior.setRealtimeConnectionState("connected");

    await waitFor(() => expect(listCards.mock.calls.length).toBeGreaterThan(before));
  });
});
