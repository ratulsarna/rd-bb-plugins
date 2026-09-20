// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COLUMNS, COLUMN_LABELS } from "../lib/columns";
import type { ExecutionDefaults } from "../lib/execution";
import { makeCard, makeSidebarThread } from "./sdk-fake";

const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;
const mounted: Array<ReturnType<typeof renderSlot>> = [];
const DEFAULT_EXECUTION: ExecutionDefaults = {
  intake: {
    providerId: "claude-code",
    model: "claude-fable-5-1",
    reasoningLevel: "high",
  },
  lead: {
    providerId: "codex",
    model: "gpt-5.6-sol",
    reasoningLevel: "xhigh",
    serviceTier: "default",
  },
};

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.lifecycle.unmount();
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function renderBoard(options?: {
  cards?: ReturnType<typeof makeCard>[];
  queuedCardIds?: string[];
  projects?: Array<{ id: string; name: string }>;
  pending?: boolean;
  ownerThreadId?: string;
  connection?: "connecting" | "connected" | "reconnecting";
  listProjects?: ReturnType<typeof vi.fn>;
  listCards?: ReturnType<typeof vi.fn>;
  listMachines?: ReturnType<typeof vi.fn>;
  executionDefaults?: ReturnType<typeof vi.fn>;
  addCard?: ReturnType<typeof vi.fn>;
  moveCard?: ReturnType<typeof vi.fn>;
  setMachine?: ReturnType<typeof vi.fn>;
}) {
  const listProjects =
    options?.listProjects ??
    vi.fn(() => ({
      projects: options?.projects ?? [{ id: "proj_1", name: "Example" }],
    }));
  const listCards =
    options?.listCards ??
    vi.fn(() => ({
      cards: options?.cards ?? [makeCard()],
      queuedCardIds: options?.queuedCardIds ?? [],
    }));
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
        executionDefaults: options?.executionDefaults ?? (() => DEFAULT_EXECUTION),
        listProjects,
        listCards,
        listMachines: options?.listMachines ?? (() => ({
          machines: [{ id: "host_mac", name: "MacBook", status: "connected" }],
        })),
        setMachine: options?.setMachine ?? (() => makeCard()),
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
    const listCards = vi.fn(() => ({ cards: [makeCard()], queuedCardIds: [] }));
    const { slot } = renderBoard({ connection: "reconnecting", listCards });
    await screen.findByText("A pipeline card");
    const before = listCards.mock.calls.length;

    await slot.behavior.setRealtimeConnectionState("connected");

    await waitFor(() => expect(listCards.mock.calls.length).toBeGreaterThan(before));
  });

  it("clears cards on a project switch and ignores an older response", async () => {
    let resolveOld!: (value: { cards: ReturnType<typeof makeCard>[]; queuedCardIds: string[] }) => void;
    let resolveCurrent!: (value: { cards: ReturnType<typeof makeCard>[]; queuedCardIds: string[] }) => void;
    const old = new Promise<{ cards: ReturnType<typeof makeCard>[]; queuedCardIds: string[] }>((resolve) => {
      resolveOld = resolve;
    });
    const current = new Promise<{ cards: ReturnType<typeof makeCard>[]; queuedCardIds: string[] }>((resolve) => {
      resolveCurrent = resolve;
    });
    let projectACalls = 0;
    const listCards = vi.fn((input: unknown) => {
      const { projectId } = input as { projectId: string };
      if (projectId === "project-a" && projectACalls++ === 0) {
        return { cards: [makeCard({ id: "a", projectId, title: "Project A" })], queuedCardIds: [] };
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
      queuedCardIds: [],
    });
    await screen.findByText("Project B");
    resolveOld({
      cards: [makeCard({ id: "stale", projectId: "project-a", title: "Stale A" })],
      queuedCardIds: [],
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

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Broken card" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
      target: { value: "host_mac" },
    });
    const intake = await screen.findByRole("group", { name: "Intake" });
    fireEvent.change(within(intake).getByRole("textbox", { name: "Model" }), {
      target: { value: "claude-opus-4-7" },
    });
    fireEvent.change(within(intake).getByRole("textbox", { name: "Reasoning level" }), {
      target: { value: "max" },
    });
    fireEvent.click(within(intake).getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not create card",
    );
    expect((screen.getByLabelText("Task title") as HTMLInputElement).value).toBe(
      "Broken card",
    );
    expect((screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement).value).toBe("host_mac");
    expect((within(intake).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("claude-opus-4-7");
    expect((within(intake).getByRole("textbox", { name: "Reasoning level" }) as HTMLInputElement).value).toBe("max");
  });

  it("requires an explicit machine for every new card, even with only one available", async () => {
    const addCard = vi.fn(() => makeCard());
    renderBoard({ addCard });
    await screen.findByText("A pipeline card");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Task" } });

    const machine = screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
    expect(machine.value).toBe("");
    fireEvent.submit(machine.closest("form")!);
    expect(addCard).not.toHaveBeenCalled();

    fireEvent.change(machine, { target: { value: "host_mac" } });
    await screen.findAllByTestId("bb-provider-model-picker");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(addCard).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj_1",
      hostId: "host_mac",
      intake: DEFAULT_EXECUTION.intake,
      lead: DEFAULT_EXECUTION.lead,
      title: "Task",
      body: "",
      attachments: [],
    }));
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    expect((screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement).value).toBe("");
  });

  it("submits independent intake and lead execution choices routed through the selected machine", async () => {
    const addCard = vi.fn(() => makeCard());
    renderBoard({
      addCard,
      listMachines: vi.fn(() => ({
        machines: [
          { id: "host_mac", name: "MacBook", status: "connected" },
          { id: "host_linux", name: "Linux", status: "connected" },
        ],
      })),
    });
    await screen.findByText("A pipeline card");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Delegate roles" } });
    const machine = screen.getByRole("combobox", { name: "Machine" });
    expect(screen.queryAllByTestId("bb-provider-model-picker")).toHaveLength(0);
    fireEvent.change(machine, { target: { value: "host_mac" } });
    await screen.findAllByTestId("bb-provider-model-picker");
    fireEvent.change(machine, { target: { value: "host_linux" } });

    const intake = await screen.findByRole("group", { name: "Intake" });
    const lead = screen.getByRole("group", { name: "Lead" });
    for (const picker of screen.getAllByTestId("bb-provider-model-picker")) {
      expect(picker.dataset.routingKind).toBe("host");
      expect(picker.dataset.routingId).toBe("host_linux");
    }

    fireEvent.change(within(intake).getByRole("textbox", { name: "Provider ID" }), {
      target: { value: "pi" },
    });
    fireEvent.change(within(intake).getByRole("textbox", { name: "Model" }), {
      target: { value: "zai/glm-5.3-flash" },
    });
    fireEvent.change(within(intake).getByRole("textbox", { name: "Reasoning level" }), {
      target: { value: "ultra" },
    });
    fireEvent.change(within(intake).getByRole("combobox", { name: "Service tier" }), {
      target: { value: "default" },
    });
    fireEvent.click(within(intake).getByRole("button", { name: "Apply execution selection" }));

    fireEvent.change(within(lead).getByRole("textbox", { name: "Model" }), {
      target: { value: "gpt-6-astra" },
    });
    fireEvent.change(within(lead).getByRole("textbox", { name: "Reasoning level" }), {
      target: { value: "max" },
    });
    fireEvent.change(within(lead).getByRole("combobox", { name: "Service tier" }), {
      target: { value: "fast" },
    });
    fireEvent.click(within(lead).getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(addCard).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj_1",
      hostId: "host_linux",
      intake: {
        providerId: "pi",
        model: "zai/glm-5.3-flash",
        reasoningLevel: "ultra",
        serviceTier: "default",
      },
      lead: {
        providerId: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "max",
        serviceTier: "fast",
      },
      title: "Delegate roles",
      body: "",
      attachments: [],
    }));
  });

  it("fetches remembered execution choices again whenever the dialog reopens", async () => {
    const latest: ExecutionDefaults = {
      intake: { providerId: "pi", model: "zai/glm-5.3-flash", reasoningLevel: "high" },
      lead: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "ultra", serviceTier: "fast" },
    };
    const executionDefaults = vi.fn()
      .mockResolvedValueOnce(DEFAULT_EXECUTION)
      .mockResolvedValueOnce(latest);
    renderBoard({ executionDefaults });
    await screen.findByText("A pipeline card");

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "host_mac" } });
    let intake = await screen.findByRole("group", { name: "Intake" });
    expect((within(intake).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("claude-fable-5-1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    await waitFor(() => expect(executionDefaults).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "host_mac" } });
    intake = await screen.findByRole("group", { name: "Intake" });
    expect((within(intake).getByRole("textbox", { name: "Provider ID" }) as HTMLInputElement).value).toBe("pi");
    expect((within(intake).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("zai/glm-5.3-flash");
    const lead = screen.getByRole("group", { name: "Lead" });
    expect((within(lead).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("gpt-6-astra");
  });

  it("does not reuse stale choices or submit when refreshing defaults fails", async () => {
    const addCard = vi.fn(() => makeCard());
    const executionDefaults = vi.fn()
      .mockResolvedValueOnce(DEFAULT_EXECUTION)
      .mockRejectedValueOnce(new Error("Could not load execution choices"));
    renderBoard({ addCard, executionDefaults });
    await screen.findByText("A pipeline card");

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "host_mac" } });
    await screen.findAllByTestId("bb-provider-model-picker");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load execution choices");
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Must not submit" } });
    const machine = screen.getByRole("combobox", { name: "Machine" });
    fireEvent.change(machine, { target: { value: "host_mac" } });
    expect(screen.queryAllByTestId("bb-provider-model-picker")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Create task" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(machine.closest("form")!);
    expect(addCard).not.toHaveBeenCalled();
  });

  it("keeps a pending task dialog open and prevents a duplicate submission", async () => {
    let finish!: (card: ReturnType<typeof makeCard>) => void;
    const addCard = vi.fn(() => new Promise<ReturnType<typeof makeCard>>((resolve) => { finish = resolve; }));
    renderBoard({ addCard });
    await screen.findByText("A pipeline card");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "One task" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "host_mac" } });
    await screen.findAllByTestId("bb-provider-model-picker");
    const form = screen.getByLabelText("Task title").closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(addCard).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.submit(form);

    expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy();
    expect((screen.getByLabelText("Task title") as HTMLInputElement).disabled).toBe(true);
    expect(addCard).toHaveBeenCalledTimes(1);
    await act(async () => finish(makeCard()));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  });

  it("requires a fresh machine choice after switching projects", async () => {
    const addCard = vi.fn(() => makeCard());
    renderBoard({
      projects: [{ id: "proj_1", name: "One" }, { id: "proj_2", name: "Two" }],
      addCard,
    });
    await screen.findByText("A pipeline card");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "host_mac" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "proj_2" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "New task" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const machine = screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
    expect(machine.value).toBe("");
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "New project task" } });
    fireEvent.submit(machine.closest("form")!);
    expect(addCard).not.toHaveBeenCalled();
  });

  it("cannot create a card when the project has no machine checkout", async () => {
    const addCard = vi.fn(() => makeCard());
    renderBoard({ addCard, listMachines: vi.fn(() => ({ machines: [] })) });
    await screen.findByText("A pipeline card");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Task" } });
    expect(screen.getByText("This project has no machine with a checkout.")).toBeTruthy();
    const machine = screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
    expect(machine.disabled).toBe(true);
    fireEvent.submit(machine.closest("form")!);
    expect(addCard).not.toHaveBeenCalled();
  });

  it("assigns an existing card only after a machine is explicitly selected", async () => {
    let card = makeCard({ hostId: null });
    const setMachine = vi.fn((input: unknown) => {
      card = { ...card, hostId: (input as { hostId: string }).hostId };
      return card;
    });
    renderBoard({ listCards: vi.fn(() => ({ cards: [card], queuedCardIds: [] })), setMachine });
    const machine = await screen.findByRole("combobox", { name: "Machine for A pipeline card" });
    expect((machine as HTMLSelectElement).value).toBe("");
    expect(setMachine).not.toHaveBeenCalled();

    fireEvent.change(machine, { target: { value: "host_mac" } });

    await screen.findByText("MacBook");
    expect(setMachine).toHaveBeenCalledExactlyOnceWith({ cardId: "card_1", hostId: "host_mac" });
    expect(screen.queryByRole("combobox", { name: "Machine for A pipeline card" })).toBeNull();
  });

  it("shows the error from a rejected move", async () => {
    const moveCard = vi.fn(async () => {
      throw new Error("no issue yet: let intake finish, or pass --issue <url>");
    });
    renderBoard({ moveCard });
    await screen.findByText("A pipeline card");

    fireEvent.click(screen.getByRole("button", { name: "Actions for A pipeline card" }));
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
    const { slot } = renderBoard({ listCards: vi.fn(() => ({ cards: [card], queuedCardIds: [] })), moveCard });
    await screen.findByText(card.title);
    const drag = dragCard();
    const target = screen.getByRole("region", { name: "To do" });

    expect(fireEvent.dragOver(target, drag)).toBe(false);
    expect(target.getAttribute("data-drop")).toBe("true");
    fireEvent.drop(target, drag);
    fireEvent.dragEnd(drag.card, drag);

    await waitFor(() => expect(moveCard).toHaveBeenCalledExactlyOnceWith({ cardId: card.id, column: "todo" }));
    expect(drag.card.draggable).toBe(false);
    expect((within(drag.card).getByRole("button", { name: `Actions for ${card.title}` }) as HTMLButtonElement).disabled).toBe(true);
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
    expect(target.getAttribute("data-drop")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Actions for A pipeline card" }));
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
    expect(target.getAttribute("data-drop")).toBe("false");
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
        return {
          cards: [makeCard({ id: projectId, projectId, title: projectId })],
          queuedCardIds: [],
        };
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
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for A pipeline card" }));
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
        queuedCardIds: [],
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

    fireEvent.click(screen.getByRole("button", { name: "Actions for Card A" }));
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
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Too many files" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
      target: { value: "host_mac" },
    });
    await screen.findAllByTestId("bb-provider-model-picker");
    fireEvent.change(screen.getByLabelText("Task attachments"), {
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
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(addCard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove file-0.txt" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Create task" }) as HTMLButtonElement).disabled).toBe(false);
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
    expect(screen.getByText("Launch failed: lead: host unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("does not show a stale working signal when an idle thread needs classification", async () => {
    renderBoard({ cards: [makeCard({ reportSignal: "working", attentionUnknown: true })] });

    await screen.findByText("Idle · awaiting status");
    expect(screen.queryByText("Working")).toBeNull();
  });

  it("hides a stale working signal on a queued card without touching other cards", async () => {
    renderBoard({
      cards: [
        makeCard({ id: "card_1", reportSignal: "working" }),
        makeCard({ id: "card_2", title: "Running task", reportSignal: "working" }),
      ],
      queuedCardIds: ["card_1"],
    });

    const queued = await screen.findByRole("article", { name: "A pipeline card" });
    expect(within(queued).getByText("Queued")).toBeTruthy();
    expect(within(queued).queryByText("Working")).toBeNull();
    expect(screen.getByRole("article", { name: "Running task" }).textContent).toContain("Working");
  });

  it("clears the queued status on the next fresh load", async () => {
    const listCards = vi.fn(() => ({ cards: [makeCard()], queuedCardIds: [] as string[] }))
      .mockReturnValueOnce({ cards: [makeCard()], queuedCardIds: ["card_1"] });
    const { slot } = renderBoard({ listCards });
    await screen.findByText("Queued");

    await slot.behavior.emitRealtime("cards:changed", { projectId: "proj_1" });

    await waitFor(() => expect(screen.queryByText("Queued")).toBeNull());
  });

  it("cannot leak a queued status from a late stale project response", async () => {
    let resolveOld!: (value: { cards: ReturnType<typeof makeCard>[]; queuedCardIds: string[] }) => void;
    const old = new Promise<{ cards: ReturnType<typeof makeCard>[]; queuedCardIds: string[] }>((resolve) => {
      resolveOld = resolve;
    });
    let projectACalls = 0;
    const listCards = vi.fn((input: unknown) => {
      const { projectId } = input as { projectId: string };
      if (projectId === "project-a" && projectACalls++ === 0) {
        return { cards: [makeCard({ id: "a", projectId, title: "Project A" })], queuedCardIds: [] };
      }
      return projectId === "project-a"
        ? old
        : { cards: [makeCard({ id: "b", projectId, title: "Project B" })], queuedCardIds: [] };
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
    await screen.findByText("Project B");

    resolveOld({
      cards: [makeCard({ id: "stale", projectId: "project-a", title: "Stale A" })],
      queuedCardIds: ["b"],
    });

    await waitFor(() => {
      expect(screen.getByText("Project B")).toBeTruthy();
      expect(screen.queryByText("Queued")).toBeNull();
      expect(screen.queryByText("Stale A")).toBeNull();
    });
  });

  it("keeps a queued card draggable and lets saving take precedence", async () => {
    const moveCard = vi.fn(() => makeCard({ column: "todo" }));
    renderBoard({ queuedCardIds: ["card_1"], moveCard });
    await screen.findByText("Queued");
    const drag = dragCard();
    const target = screen.getByRole("region", { name: "To do" });
    fireEvent.dragOver(target, drag);
    fireEvent.drop(target, drag);

    expect(within(drag.card).getByText("Saving")).toBeTruthy();
    expect(within(drag.card).queryByText("Queued")).toBeNull();
    await waitFor(() => expect(moveCard).toHaveBeenCalledExactlyOnceWith({ cardId: "card_1", column: "todo" }));
  });
});
