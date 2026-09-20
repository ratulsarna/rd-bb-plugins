// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  vi.unstubAllGlobals();
});

function renderBoard(options?: {
  cards?: ReturnType<typeof makeCard>[];
  projects?: Array<{ id: string; name: string }>;
  pending?: boolean;
  ownerThreadId?: string;
  connection?: "connecting" | "connected" | "reconnecting";
  listProjects?: ReturnType<typeof vi.fn>;
  listCards?: ReturnType<typeof vi.fn>;
  addCard?: ReturnType<typeof vi.fn>;
  moveCard?: ReturnType<typeof vi.fn>;
}) {
  const listProjects =
    options?.listProjects ??
    vi.fn(() => ({
      projects: options?.projects ?? [{ id: "proj_1", name: "Example" }],
    }));
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
        listProjects,
        listCards,
        addCard: options?.addCard ?? (() => makeCard()),
        moveCard:
          options?.moveCard ??
          ((input: unknown) => {
            const { cardId, column } = input as { cardId: string; column: string };
            return makeCard({ id: cardId, column: column as never });
          }),
        retryLaunch: () => makeCard(),
        removeCard: () => ({ removed: true }),
        showCard: () => ({ card: makeCard(), history: [] }),
      },
    },
  );
  mounted.push(slot);
  return { slot, listProjects, listCards };
}

function dragCard(title = "A pipeline card") {
  const data = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "uninitialized",
    dropEffect: "none",
    get types() { return [...data.keys()]; },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
  const card = screen.getByRole("article", { name: title });
  fireEvent.dragStart(card, { dataTransfer });
  return { card, dataTransfer };
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
      cards: [makeCard({ leadThreadId: "lead", ownerRole: "lead" })],
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

  it("clears cards on a project switch and ignores an older response", async () => {
    let resolveOld!: (value: { cards: ReturnType<typeof makeCard>[] }) => void;
    let resolveCurrent!: (value: { cards: ReturnType<typeof makeCard>[] }) => void;
    const old = new Promise<{ cards: ReturnType<typeof makeCard>[] }>((resolve) => {
      resolveOld = resolve;
    });
    const current = new Promise<{ cards: ReturnType<typeof makeCard>[] }>((resolve) => {
      resolveCurrent = resolve;
    });
    let projectACalls = 0;
    const listCards = vi.fn((input: unknown) => {
      const { projectId } = input as { projectId: string };
      if (projectId === "project-a" && projectACalls++ === 0) {
        return { cards: [makeCard({ id: "a", projectId, title: "Project A" })] };
      }
      return projectId === "project-a" ? old : current;
    });
    renderBoard({
      projects: [
        { id: "project-a", name: "A" },
        { id: "project-b", name: "B" },
      ],
      listCards,
    });
    await screen.findByText("Project A");

    fireEvent.click(screen.getByRole("checkbox", { name: "Show done" }));
    await waitFor(() => expect(listCards).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
      target: { value: "project-b" },
    });

    await waitFor(() => expect(screen.queryByText("Project A")).toBeNull());
    await waitFor(() => expect(listCards).toHaveBeenCalledTimes(3));
    resolveCurrent({
      cards: [makeCard({ id: "b", projectId: "project-b", title: "Project B" })],
    });
    await screen.findByText("Project B");
    resolveOld({
      cards: [makeCard({ id: "stale", projectId: "project-a", title: "Stale A" })],
    });

    await waitFor(() => {
      expect(screen.getByText("Project B")).toBeTruthy();
      expect(screen.queryByText("Stale A")).toBeNull();
    });
  });

  it("keeps the add form open when creating a card fails", async () => {
    const addCard = vi.fn(async () => {
      throw new Error("Could not create card");
    });
    renderBoard({ addCard });
    await screen.findByText("A pipeline card");

    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    fireEvent.change(screen.getByLabelText("Card title"), {
      target: { value: "Broken card" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not create card",
    );
    expect((screen.getByLabelText("Card title") as HTMLInputElement).value).toBe(
      "Broken card",
    );
  });

  it("shows the error from a rejected move", async () => {
    const moveCard = vi.fn(async () => {
      throw new Error("no issue yet: let intake finish, or pass --issue <url>");
    });
    renderBoard({ moveCard });
    await screen.findByText("A pipeline card");

    fireEvent.change(
      screen.getByRole("combobox", { name: "Move A pipeline card" }),
      { target: { value: "planning" } },
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "no issue yet: let intake finish, or pass --issue <url>",
    );
  });

  it("drops into an empty column, blocks another move until saved, and reloads the card", async () => {
    let card = makeCard();
    let finishMove!: () => void;
    const moveCard = vi.fn(() => new Promise<ReturnType<typeof makeCard>>((resolve) => {
      finishMove = () => {
        card = { ...card, column: "todo" };
        resolve(card);
      };
    }));
    const { slot } = renderBoard({ listCards: vi.fn(() => ({ cards: [card] })), moveCard });
    await screen.findByText(card.title);
    const drag = dragCard();
    const target = screen.getByRole("region", { name: "To do" });

    expect(fireEvent.dragOver(target, drag)).toBe(false);
    expect(target.className).toContain("ring-primary");
    fireEvent.drop(target, drag);
    fireEvent.dragEnd(drag.card, drag);

    await waitFor(() => expect(moveCard).toHaveBeenCalledExactlyOnceWith({ cardId: card.id, column: "todo" }));
    expect(drag.card.draggable).toBe(false);
    expect((screen.getByRole("combobox", { name: `Move ${card.title}` }) as HTMLSelectElement).disabled).toBe(true);
    fireEvent.drop(target, drag);
    expect(moveCard).toHaveBeenCalledTimes(1);
    expect(slot.inspection.navigateCalls).toEqual([]);

    finishMove();
    await waitFor(() => expect(within(target).getByRole("article").draggable).toBe(true));
    expect(within(screen.getByRole("region", { name: "Backlog" })).queryByRole("article")).toBeNull();
  });

  it("keeps a rejected drop in its source column and allows retry", async () => {
    const moveCard = vi.fn(async () => {
      throw new Error("no issue yet: let intake finish, or pass --issue <url>");
    });
    renderBoard({ moveCard });
    await screen.findByText("A pipeline card");
    const drag = dragCard();
    const target = screen.getByRole("region", { name: "Planning" });
    fireEvent.dragOver(target, drag);
    fireEvent.drop(target, drag);

    expect((await screen.findByRole("alert")).textContent).toContain("no issue yet");
    const source = screen.getByRole("region", { name: "Backlog" });
    expect(within(source).getByRole("article").draggable).toBe(true);
    expect(within(target).queryByRole("article")).toBeNull();
    expect(target.className).not.toContain("ring-primary");

    fireEvent.change(screen.getByRole("combobox", { name: "Move A pipeline card" }), {
      target: { value: "todo" },
    });
    await waitFor(() => expect(moveCard).toHaveBeenCalledTimes(2));
    await screen.findByRole("alert");
  });

  it("ignores same-column, external, and cancelled drops", async () => {
    const moveCard = vi.fn(() => makeCard());
    renderBoard({ moveCard, cards: [makeCard({ column: "planning" })] });
    await screen.findByText("A pipeline card");
    const drag = dragCard();
    const source = screen.getByRole("region", { name: "Planning" });
    const target = screen.getByRole("region", { name: "To do" });

    expect(fireEvent.dragOver(source, drag)).toBe(true);
    fireEvent.drop(source, drag);
    expect(moveCard).not.toHaveBeenCalled();

    fireEvent.dragStart(drag.card, drag);
    const external = { dataTransfer: { types: ["Files"], getData: () => "" } };
    expect(fireEvent.dragOver(target, external)).toBe(true);
    fireEvent.drop(target, external);
    expect(moveCard).not.toHaveBeenCalled();
    fireEvent.dragOver(target, drag);
    fireEvent.dragEnd(drag.card, drag);
    expect(target.className).not.toContain("ring-primary");
    expect(fireEvent.dragOver(target, drag)).toBe(true);
    fireEvent.drop(target, drag);
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("invalidates a drag when the project changes", async () => {
    const moveCard = vi.fn(() => makeCard());
    renderBoard({
      projects: [{ id: "proj_1", name: "One" }, { id: "proj_2", name: "Two" }],
      listCards: vi.fn((input: unknown) => {
        const { projectId } = input as { projectId: string };
        return { cards: [makeCard({ id: projectId, projectId, title: projectId })] };
      }),
      moveCard,
    });
    await screen.findByText("proj_1");
    const drag = dragCard("proj_1");
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
      target: { value: "proj_2" },
    });
    await screen.findByText("proj_2");
    const target = screen.getByRole("region", { name: "Planning" });
    expect(fireEvent.dragOver(target, drag)).toBe(true);
    fireEvent.drop(target, drag);
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("prevents a drag from card actions without blocking the next title drag", async () => {
    const moveCard = vi.fn(() => makeCard({ column: "todo" }));
    renderBoard({ moveCard });
    const title = await screen.findByText("A pipeline card");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Remove" }));
    const drag = dragCard();
    const target = screen.getByRole("region", { name: "To do" });
    fireEvent.drop(target, drag);
    expect(moveCard).not.toHaveBeenCalled();

    fireEvent.pointerDown(title);
    fireEvent.dragStart(drag.card, drag);
    fireEvent.drop(target, drag);
    await waitFor(() => expect(moveCard).toHaveBeenCalledExactlyOnceWith({ cardId: "card_1", column: "todo" }));
    await waitFor(() => expect(drag.card.draggable).toBe(true));
  });

  it.each(["resolve", "reject"] as const)("keeps the selected project after an earlier move %s", async (outcome) => {
    let finishMove!: (value: ReturnType<typeof makeCard>) => void;
    let rejectMove!: (reason: Error) => void;
    const moveCard = vi.fn(
      () =>
        new Promise<ReturnType<typeof makeCard>>((resolve, reject) => {
          finishMove = resolve;
          rejectMove = reject;
        }),
    );
    const listCards = vi.fn((input: unknown) => {
      const { projectId } = input as { projectId: string };
      return {
        cards: [
          makeCard({
            id: projectId,
            projectId,
            title: projectId === "project-a" ? "Card A" : "Card B",
          }),
        ],
      };
    });
    renderBoard({
      projects: [
        { id: "project-a", name: "A" },
        { id: "project-b", name: "B" },
      ],
      listCards,
      moveCard,
    });
    await screen.findByText("Card A");

    fireEvent.change(screen.getByRole("combobox", { name: "Move Card A" }), {
      target: { value: "todo" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
      target: { value: "project-b" },
    });
    await screen.findByText("Card B");

    await act(async () => {
      if (outcome === "resolve") finishMove(makeCard({ id: "project-a", projectId: "project-a" }));
      else rejectMove(new Error("Project A move failed"));
    });
    if (outcome === "resolve") {
      await waitFor(() => expect(listCards.mock.calls.length).toBeGreaterThan(2));
    }
    expect(listCards.mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: "project-b",
    });
    expect(screen.getByText("Card B")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recovers a failed project load on the next connection", async () => {
    let attempts = 0;
    const listProjects = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("projects unavailable");
      return { projects: [{ id: "proj_1", name: "Example" }] };
    });
    const { slot } = renderBoard({
      connection: "connecting",
      listProjects,
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "projects unavailable",
    );

    await slot.behavior.setRealtimeConnectionState("connected");

    await screen.findByText("A pipeline card");
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it("rejects more than 20 attachments before upload", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const addCard = vi.fn(() => makeCard());
    renderBoard({ addCard });
    await screen.findByText("A pipeline card");
    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    fireEvent.change(screen.getByLabelText("Card title"), {
      target: { value: "Too many files" },
    });
    fireEvent.change(screen.getByLabelText("Card attachments"), {
      target: {
        files: Array.from(
          { length: 21 },
          (_, index) => new File(["x"], `file-${index}.txt`),
        ),
      },
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Choose at most 20 attachments.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(addCard).not.toHaveBeenCalled();
  });

  it("shows a launch error alongside another attention reason", async () => {
    renderBoard({
      cards: [
        makeCard({
          needsUser: true,
          attentionReason: "thread deleted",
          launchError: "lead: host unavailable",
        }),
      ],
    });

    await screen.findByText("thread deleted");
    expect(screen.getByText("launch failed: lead: host unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
