// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COLUMNS, COLUMN_LABELS } from "../lib/columns";
import type { MachineQueue } from "../lib/contract";
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

function makeMachineQueue(overrides: Partial<MachineQueue> = {}): MachineQueue {
  return {
    hostId: "host_mac",
    hostName: "MacBook",
    limit: 2,
    occupied: [],
    waiting: [],
    nextCardId: null,
    ...overrides,
  };
}

function waitingQueue(cardIds: string[]): MachineQueue[] {
  return [makeMachineQueue({
    waiting: cardIds.map((cardId) => ({
      cardId,
      title: cardId,
      threadId: null,
      reasons: ["Machine capacity is full"],
      canRunNext: true,
    })),
  })];
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.lifecycle.unmount();
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function renderBoard(options?: {
  cards?: ReturnType<typeof makeCard>[];
  queue?: MachineQueue[];
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
  retryLaunch?: ReturnType<typeof vi.fn>;
  pauseCard?: ReturnType<typeof vi.fn>;
  resumeCard?: ReturnType<typeof vi.fn>;
  stopCard?: ReturnType<typeof vi.fn>;
  setRunNext?: ReturnType<typeof vi.fn>;
  removeCard?: ReturnType<typeof vi.fn>;
  startCard?: ReturnType<typeof vi.fn>;
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
      queue: options?.queue ?? [makeMachineQueue()],
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
        retryLaunch: options?.retryLaunch ?? (() => makeCard()),
        pauseCard: options?.pauseCard ?? (() => makeCard({ runState: "pause_requested" })),
        resumeCard: options?.resumeCard ?? (() => makeCard()),
        stopCard: options?.stopCard ?? (() => makeCard({ runState: "stopping" })),
        setRunNext: options?.setRunNext ?? (() => ({ ok: true as const })),
        removeCard: options?.removeCard ?? (() => ({ removed: true })),
        startCard: options?.startCard ?? (() => makeCard()),
        showCard: () => ({ card: makeCard(), history: [], queued: false }),
      },
    },
  );
  mounted.push(slot);
  return { slot, listProjects, listCards };
}

function dragCard(title = "A pipeline card") {
  if (screen.getByRole("button", { name: "Board" }).getAttribute("aria-pressed") !== "true") {
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
  }
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

async function fillNewTask(title: string) {
  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  fireEvent.change(screen.getByLabelText("Task title"), { target: { value: title } });
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "host_mac" } });
  await screen.findAllByTestId("bb-provider-model-picker");
}

describe("pipeline board", () => {
  it("defaults to tasks, hides done, and shows only occupied stages in Board", async () => {
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
    expect(screen.getByRole("button", { name: "Tasks" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("article", { name: "Needs a choice" }).draggable).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    const regions = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
    expect(regions).toEqual(["Backlog"]);
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

  it("sends exact pause, resume, and stop actions for their run states", async () => {
    const pauseCard = vi.fn(() => makeCard({ runState: "pause_requested" }));
    const resumeCard = vi.fn(() => makeCard({ runState: "running" }));
    const stopCard = vi.fn(() => makeCard({ runState: "stopping" }));
    renderBoard({
      cards: [
        makeCard({ id: "running", title: "Running card" }),
        makeCard({ id: "paused", title: "Paused card", runState: "paused" }),
        makeCard({ id: "pausing", title: "Pausing card", runState: "pausing" }),
      ],
      pauseCard,
      resumeCard,
      stopCard,
    });

    await screen.findByText("Running card");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Running card" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pauseCard).toHaveBeenCalledExactlyOnceWith({ cardId: "running" }));

    fireEvent.click(screen.getByRole("button", { name: "Actions for Paused card" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resumeCard).toHaveBeenCalledExactlyOnceWith({ cardId: "paused" }));

    fireEvent.click(screen.getByRole("button", { name: "Actions for Pausing card" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop now" }));
    await waitFor(() => expect(stopCard).toHaveBeenCalledExactlyOnceWith({ cardId: "pausing" }));
  });

  it("retries a failed pause through pauseCard and permits force-stop retries", async () => {
    const pauseCard = vi.fn(() => makeCard({ runState: "pause_requested" }));
    const stopCard = vi.fn(() => makeCard({ runState: "stopping" }));
    renderBoard({
      cards: [
        makeCard({
          id: "failed-pause",
          title: "Failed pause",
          runState: "pause_requested",
          controlError: "Owner did not acknowledge pause",
        }),
        makeCard({ id: "stopping", title: "Stopping card", runState: "stopping" }),
      ],
      pauseCard,
      stopCard,
    });

    await screen.findByText("Owner did not acknowledge pause");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Failed pause" }));
    expect(screen.getByRole("button", { name: "Stop now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry pause" }));
    await waitFor(() => expect(pauseCard).toHaveBeenCalledExactlyOnceWith({ cardId: "failed-pause" }));

    fireEvent.click(screen.getByRole("button", { name: "Actions for Stopping card" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop now" }));
    await waitFor(() => expect(stopCard).toHaveBeenCalledExactlyOnceWith({ cardId: "stopping" }));
  });

  it("shows run-state status and retains a live question that blocks pause delivery", async () => {
    renderBoard({
      pending: true,
      queue: [{
        ...waitingQueue(["requested", "pausing", "paused", "stopping"])[0]!,
        nextCardId: "paused",
      }],
      cards: [
        makeCard({ id: "requested", title: "Requested", runState: "pause_requested", reportSignal: "working", needsUser: true, attentionReason: "stale question" }),
        makeCard({ id: "pausing", title: "Pausing card", runState: "pausing", reportSignal: "working" }),
        makeCard({ id: "paused", title: "Paused card", runState: "paused", reportSignal: "working" }),
        makeCard({ id: "stopping", title: "Stopping card", runState: "stopping", reportSignal: "working" }),
      ],
    });

    await screen.findByText("Pause requested");
    expect(within(screen.getByRole("article", { name: "Pausing card" })).getByText("Pausing")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Paused card" })).getByText("Paused")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Stopping card" })).getByText("Stopping")).toBeTruthy();
    expect(screen.queryAllByRole("article").some((card) => within(card).queryByText("Queued") !== null)).toBe(false);
    expect(screen.queryByText("Next")).toBeNull();
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryByText("stale question")).toBeNull();
    expect(within(screen.getByRole("article", { name: "Requested" })).getByLabelText("Question open")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Paused card" })).queryByLabelText("Question open")).toBeNull();
    expect(screen.getByRole("button", { name: "Needs you 1" })).toBeTruthy();
  });

  it("shows saving ahead of run state while a control action is pending", async () => {
    let finishResume!: () => void;
    const resumeCard = vi.fn(() => new Promise<ReturnType<typeof makeCard>>((resolve) => {
      finishResume = () => resolve(makeCard({ runState: "running" }));
    }));
    renderBoard({
      cards: [makeCard({ runState: "paused" })],
      queue: waitingQueue(["card_1"]),
      resumeCard,
    });
    await screen.findByText("Paused");
    fireEvent.click(screen.getByRole("button", { name: "Actions for A pipeline card" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    const card = screen.getByRole("article", { name: "A pipeline card" });
    expect(within(card).getByText("Saving")).toBeTruthy();
    expect(within(card).queryByText("Paused")).toBeNull();
    expect(within(card).queryByText("Queued")).toBeNull();
    expect((within(card).getByRole("button", { name: "Actions for A pipeline card" }) as HTMLButtonElement).disabled).toBe(true);
    expect(resumeCard).toHaveBeenCalledExactlyOnceWith({ cardId: "card_1" });

    await act(async () => finishResume());
    await waitFor(() => expect(within(card).getByText("Paused")).toBeTruthy());
  });

  it("blocks non-running mutations while preserving actions and owner-thread access", async () => {
    const moveCard = vi.fn(() => makeCard());
    const retryLaunch = vi.fn(() => makeCard());
    const removeCard = vi.fn(() => ({ removed: true }));
    const { slot } = renderBoard({
      cards: [makeCard({ runState: "paused", launchError: "old launch failure" })],
      moveCard,
      retryLaunch,
      removeCard,
    });
    const title = await screen.findByText("A pipeline card");
    const card = screen.getByRole("article", { name: "A pipeline card" });
    expect(card.draggable).toBe(false);
    expect(within(card).queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(title.closest("button")!);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "intake" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for A pipeline card" }));
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Move A pipeline card" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole("combobox", { name: "Move A pipeline card" }), { target: { value: "todo" } });
    fireEvent.click(screen.getByRole("button", { name: "Actions for A pipeline card" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(moveCard).not.toHaveBeenCalled();
    expect(retryLaunch).not.toHaveBeenCalled();
    expect(removeCard).not.toHaveBeenCalled();
  });

  it("does not offer lifecycle controls for done cards", async () => {
    renderBoard({ cards: [makeCard({ title: "Finished", column: "done" })] });
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await screen.findByText("Finished");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Finished" }));

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop now" })).toBeNull();
  });

  it("refetches when realtime reconnects", async () => {
    const listCards = vi.fn(() => ({ cards: [makeCard()], queue: [makeMachineQueue()] }));
    const { slot } = renderBoard({ connection: "reconnecting", listCards });
    await screen.findByText("A pipeline card");
    const before = listCards.mock.calls.length;

    await slot.behavior.setRealtimeConnectionState("connected");

    await waitFor(() => expect(listCards.mock.calls.length).toBeGreaterThan(before));
  });

  it("clears cards on a project switch and ignores an older response", async () => {
    let resolveOld!: (value: { cards: ReturnType<typeof makeCard>[]; queue: MachineQueue[] }) => void;
    let resolveCurrent!: (value: { cards: ReturnType<typeof makeCard>[]; queue: MachineQueue[] }) => void;
    const old = new Promise<{ cards: ReturnType<typeof makeCard>[]; queue: MachineQueue[] }>((resolve) => {
      resolveOld = resolve;
    });
    const current = new Promise<{ cards: ReturnType<typeof makeCard>[]; queue: MachineQueue[] }>((resolve) => {
      resolveCurrent = resolve;
    });
    let projectACalls = 0;
    const listCards = vi.fn((input: unknown) => {
      const { projectId } = input as { projectId: string };
      if (projectId === "project-a" && projectACalls++ === 0) {
        return { cards: [makeCard({ id: "a", projectId, title: "Project A" })], queue: [makeMachineQueue()] };
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

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(listCards).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
      target: { value: "project-b" },
    });

    await waitFor(() => expect(screen.queryByText("Project A")).toBeNull());
    await waitFor(() => expect(listCards).toHaveBeenCalledTimes(3));
    resolveCurrent({
      cards: [makeCard({ id: "b", projectId: "project-b", title: "Project B" })],
      queue: [makeMachineQueue({ hostName: "Project B machine" })],
    });
    await screen.findByText("Project B");
    resolveOld({
      cards: [makeCard({ id: "stale", projectId: "project-a", title: "Stale A" })],
      queue: [makeMachineQueue({ hostName: "Stale machine" })],
    });

    await waitFor(() => {
      expect(screen.getByText("Project B")).toBeTruthy();
      expect(screen.queryByText("Stale A")).toBeNull();
    });
  });

  it("keeps the add form open when a save fails", async () => {
    const fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({ type: "localFile", path: "/attachments/note.txt", name: "note.txt", sizeBytes: 4 }),
    }));
    vi.stubGlobal("fetch", fetch);
    const addCard = vi.fn(async () => {
      throw new Error("Could not create card");
    });
    renderBoard({ addCard });
    await screen.findByText("A pipeline card");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New task" }));
    });
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
    fireEvent.change(screen.getByLabelText("Task attachments"), {
      target: { files: [new File(["note"], "note.txt")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not create card",
    );
    expect(addCard).toHaveBeenCalledWith(expect.objectContaining({
      intake: expect.objectContaining({ model: "claude-opus-4-7", reasoningLevel: "max" }),
      attachments: [expect.objectContaining({ filename: "note.txt" })],
      start: false,
    }));
    expect((screen.getByLabelText("Task title") as HTMLInputElement).value).toBe(
      "Broken card",
    );
    expect((screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement).value).toBe("host_mac");
    expect((within(intake).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("claude-opus-4-7");
    expect((within(intake).getByRole("textbox", { name: "Reasoning level" }) as HTMLInputElement).value).toBe("max");
    expect(screen.getByText("note.txt")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save and start" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("uploads attachments and sends start false for Save and true for Save and start", async () => {
    const fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({ type: "localFile", path: "/attachments/spec.md", name: "spec.md", sizeBytes: 12 }),
    }));
    vi.stubGlobal("fetch", fetch);
    const addCard = vi.fn(() => makeCard());
    renderBoard({ addCard });
    await screen.findByText("A pipeline card");

    await fillNewTask("Twice");
    fireEvent.change(screen.getByLabelText("Task attachments"), {
      target: { files: [new File(["spec"], "spec.md")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(addCard).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj_1",
      hostId: "host_mac",
      intake: DEFAULT_EXECUTION.intake,
      lead: DEFAULT_EXECUTION.lead,
      title: "Twice",
      body: "",
      attachments: [{ path: "/attachments/spec.md", filename: "spec.md", sizeBytes: 12, isImage: false }],
      start: false,
    }));
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("/attachments"),
      expect.objectContaining({ method: "POST" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());

    await fillNewTask("Twice");
    fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
    await waitFor(() => expect(addCard).toHaveBeenCalledTimes(2));
    expect(addCard).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Twice",
      attachments: [],
      start: true,
    }));
  });

  it("treats a form submission without a submitter as Save", async () => {
    const addCard = vi.fn(() => makeCard());
    renderBoard({ addCard });
    await screen.findByText("A pipeline card");

    await fillNewTask("Implicit");
    fireEvent.submit(screen.getByLabelText("Task title").closest("form")!);

    await waitFor(() => expect(addCard).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Implicit", start: false }),
    ));
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
    fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
    await waitFor(() => expect(addCard).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj_1",
      hostId: "host_mac",
      intake: DEFAULT_EXECUTION.intake,
      lead: DEFAULT_EXECUTION.lead,
      title: "Task",
      body: "",
      attachments: [],
      start: true,
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
    fireEvent.click(screen.getByRole("button", { name: "Save and start" }));

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
      start: true,
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
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save and start" }) as HTMLButtonElement).disabled).toBe(true);
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
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save and start" }) as HTMLButtonElement).disabled).toBe(true);
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
    renderBoard({ listCards: vi.fn(() => ({ cards: [card], queue: [makeMachineQueue()] })), setMachine });
    const machine = await screen.findByRole("combobox", { name: "Machine for A pipeline card" });
    expect((machine as HTMLSelectElement).value).toBe("");
    expect(setMachine).not.toHaveBeenCalled();

    fireEvent.change(machine, { target: { value: "host_mac" } });

    await waitFor(() => expect(within(screen.getByRole("article", { name: "A pipeline card" })).getByText("MacBook")).toBeTruthy());
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
    const { slot } = renderBoard({ listCards: vi.fn(() => ({ cards: [card], queue: [makeMachineQueue()] })), moveCard });
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
    await waitFor(() => expect(within(screen.getByRole("region", { name: "To do" })).getByRole("article").draggable).toBe(true));
    expect(screen.queryByRole("region", { name: "Backlog" })).toBeNull();
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
    expect(screen.queryByRole("region", { name: "Planning" })).toBeNull();

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
          queue: [makeMachineQueue()],
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
    const target = screen.getByRole("region", { name: "Backlog" });
    expect(fireEvent.dragOver(target, drag)).toBe(true);
    fireEvent.drop(target, drag);
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("prevents a drag from card actions without blocking the next title drag", async () => {
    const moveCard = vi.fn(() => makeCard({ column: "todo" }));
    renderBoard({ moveCard });
    await screen.findByText("A pipeline card");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    const title = screen.getByRole("button", { name: "A pipeline card" });
    const rejectedDrag = dragCard();
    fireEvent.dragEnd(rejectedDrag.card, rejectedDrag);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for A pipeline card" }));
    const drag = dragCard();
    fireEvent.drop(screen.getByRole("region", { name: "Backlog" }), drag);
    expect(moveCard).not.toHaveBeenCalled();

    fireEvent.pointerDown(title);
    fireEvent.dragStart(drag.card, drag);
    fireEvent.drop(screen.getByRole("region", { name: "To do" }), drag);
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
        queue: [makeMachineQueue()],
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
    fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(addCard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove file-0.txt" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Save and start" }) as HTMLButtonElement).disabled).toBe(false);
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

    await screen.findByText("Launch failed: lead: host unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Details for A pipeline card" }));
    expect(screen.getByText("thread deleted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps a saved task immobile without lifecycle controls until Start, then starts it", async () => {
    let card = makeCard({ startRequested: false, intakeThreadId: null });
    const moveCard = vi.fn(() => makeCard());
    const startCard = vi.fn(() => {
      card = makeCard({ startRequested: true });
      return card;
    });
    const listCards = vi.fn(() => ({
      cards: [card, makeCard({ id: "started-peer", title: "Started peer", column: "todo" })],
      queue: card.startRequested ? waitingQueue(["card_1"]) : [makeMachineQueue()],
    }));
    renderBoard({ listCards, startCard, moveCard });
    await screen.findByText("A pipeline card");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    const title = screen.getByRole("button", { name: "A pipeline card" });
    const saved = screen.getByRole("article", { name: "A pipeline card" });
    const peer = screen.getByRole("article", { name: "Started peer" });

    expect(within(saved).getByText("Not started")).toBeTruthy();
    expect(within(saved).getByRole("button", { name: "Start" })).toBeTruthy();
    expect(within(peer).queryByText("Not started")).toBeNull();
    expect(within(peer).queryByRole("button", { name: "Start" })).toBeNull();
    expect(saved.draggable).toBe(false);
    expect((title.closest("button") as HTMLButtonElement).disabled).toBe(false);

    const drag = dragCard();
    const target = screen.getByRole("region", { name: "To do" });
    fireEvent.dragOver(target, drag);
    fireEvent.drop(target, drag);
    fireEvent.dragEnd(drag.card, drag);
    expect(moveCard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Actions for A pipeline card" }));
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run next" })).toBeNull();
    expect((screen.getByRole("combobox", { name: "Move A pipeline card" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByRole("combobox", { name: "Move A pipeline card" }), { target: { value: "todo" } });
    expect(moveCard).not.toHaveBeenCalled();

    const start = within(saved).getByRole("button", { name: "Start" }) as HTMLButtonElement;
    fireEvent.click(start);
    expect(start.disabled).toBe(true);
    expect(startCard).toHaveBeenCalledExactlyOnceWith({ cardId: "card_1" });

    await within(await screen.findByRole("article", { name: "A pipeline card" })).findByText("Queued");
    expect(screen.queryByText("Not started")).toBeNull();
    expect(screen.getByRole("article", { name: "A pipeline card" }).draggable).toBe(true);
  });

  it("reports a failed start and keeps the task saved", async () => {
    const startCard = vi.fn(async () => {
      throw new Error("host unreachable");
    });
    renderBoard({
      cards: [makeCard({ startRequested: false, intakeThreadId: null })],
      startCard,
    });
    await screen.findByText("Not started");

    fireEvent.click(within(screen.getByRole("article", { name: "A pipeline card" })).getByRole("button", { name: "Start" }));

    expect((await screen.findByRole("alert")).textContent).toContain("host unreachable");
    const saved = screen.getByRole("article", { name: "A pipeline card" });
    expect(within(saved).getByText("Not started")).toBeTruthy();
    expect(within(saved).getByRole("button", { name: "Start" })).toBeTruthy();
    expect(saved.draggable).toBe(false);
    expect(startCard).toHaveBeenCalledExactlyOnceWith({ cardId: "card_1" });
  });

  it("suppresses stale attention, question, working, and queue signals on a saved task", async () => {
    renderBoard({
      pending: true,
      cards: [makeCard({
        startRequested: false,
        intakeThreadId: "intake",
        needsUser: true,
        attentionReason: "stale choice",
        reportSignal: "working",
        launchError: "stale launch failure",
      })],
      queue: waitingQueue(["card_1"]),
    });
    const saved = await screen.findByRole("article", { name: "A pipeline card" });

    expect(within(saved).getByText("Not started")).toBeTruthy();
    expect(screen.queryByText("stale choice")).toBeNull();
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryAllByRole("article").some((card) => within(card).queryByText("Queued") !== null)).toBe(false);
    expect(within(saved).queryByLabelText("Question open")).toBeNull();
    expect(screen.queryByText(/Launch failed/)).toBeNull();
    expect(screen.queryByText(/need your attention/)).toBeNull();
  });

  it("hides Start for a saved task in a done or held state", async () => {
    renderBoard({
      cards: [
        makeCard({ id: "done-saved", title: "Saved done", column: "done", startRequested: false }),
        makeCard({ id: "held-saved", title: "Saved paused", runState: "paused", startRequested: false }),
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await screen.findByText("Saved done");

    expect(screen.queryByText("Not started")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Open/ }));
    expect(within(await screen.findByRole("article", { name: "Saved paused" })).queryByRole("button", { name: "Start" })).toBeNull();
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
      queue: waitingQueue(["card_1"]),
    });

    const queued = await screen.findByRole("article", { name: "A pipeline card" });
    expect(within(queued).getByText("Queued")).toBeTruthy();
    expect(within(queued).queryByText("Working")).toBeNull();
    expect(screen.getByRole("article", { name: "Running task" }).textContent).toContain("Working");
  });

  it("clears the queued status on the next fresh load", async () => {
    const listCards = vi.fn(() => ({ cards: [makeCard()], queue: [makeMachineQueue()] }))
      .mockReturnValueOnce({ cards: [makeCard()], queue: waitingQueue(["card_1"]) });
    const { slot } = renderBoard({ listCards });
    await within(await screen.findByRole("article", { name: "A pipeline card" })).findByText("Queued");

    await slot.behavior.emitRealtime("cards:changed", { projectId: "proj_1" });

    await waitFor(() => expect(within(screen.getByRole("article", { name: "A pipeline card" })).queryByText("Queued")).toBeNull());
  });

  it("cannot leak queue state from a late stale project response", async () => {
    let resolveOld!: (value: { cards: ReturnType<typeof makeCard>[]; queue: MachineQueue[] }) => void;
    const old = new Promise<{ cards: ReturnType<typeof makeCard>[]; queue: MachineQueue[] }>((resolve) => {
      resolveOld = resolve;
    });
    let projectACalls = 0;
    const listCards = vi.fn((input: unknown) => {
      const { projectId } = input as { projectId: string };
      if (projectId === "project-a" && projectACalls++ === 0) {
        return { cards: [makeCard({ id: "a", projectId, title: "Project A" })], queue: [makeMachineQueue({ hostName: "Project A machine" })] };
      }
      return projectId === "project-a"
        ? old
        : { cards: [makeCard({ id: "b", projectId, title: "Project B" })], queue: [makeMachineQueue({ hostName: "Project B machine" })] };
    });
    renderBoard({
      projects: [
        { id: "project-a", name: "A" },
        { id: "project-b", name: "B" },
      ],
      listCards,
    });
    await screen.findByText("Project A");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(listCards).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
      target: { value: "project-b" },
    });
    await screen.findByText("Project B");

    resolveOld({
      cards: [makeCard({ id: "stale", projectId: "project-a", title: "Stale A" })],
      queue: [makeMachineQueue({
        hostName: "Stale machine",
        waiting: [{
          cardId: "b",
          title: "Project B",
          threadId: "stale-thread",
          reasons: ["Stale capacity reason"],
          canRunNext: true,
        }],
        nextCardId: "b",
      })],
    });

    await waitFor(() => {
      expect(screen.getByText("Project B")).toBeTruthy();
      expect(screen.queryAllByRole("article").some((card) => within(card).queryByText("Queued") !== null)).toBe(false);
      expect(screen.queryByText("Stale A")).toBeNull();
      expect(screen.getByRole("button", { name: /Project B machine queue/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Stale machine queue/ })).toBeNull();
    });
  });

  it("keeps a queued card draggable and lets saving take precedence", async () => {
    const moveCard = vi.fn(() => makeCard({ column: "todo" }));
    renderBoard({ queue: waitingQueue(["card_1"]), moveCard });
    await within(await screen.findByRole("article", { name: "A pipeline card" })).findByText("Queued");
    const drag = dragCard();
    const target = screen.getByRole("region", { name: "To do" });
    fireEvent.dragOver(target, drag);
    fireEvent.drop(target, drag);

    expect(within(drag.card).getByText("Saving")).toBeTruthy();
    expect(within(drag.card).queryByText("Queued")).toBeNull();
    await waitFor(() => expect(moveCard).toHaveBeenCalledExactlyOnceWith({ cardId: "card_1", column: "todo" }));
  });

  it("opens snapshot thread references and shows queue reasons and empty slots", async () => {
    const { slot } = renderBoard({
      queue: [makeMachineQueue({
        hostName: "rdlegion",
        limit: 3,
        occupied: [{ cardId: "removed", title: "Removed task", threadId: "thread-removed" }],
        waiting: [{
          cardId: "card_1",
          title: "A pipeline card",
          threadId: "intake",
          reasons: ["Machine limit reached", "Waiting for active goal"],
          canRunNext: true,
        }],
        nextCardId: null,
      })],
    });
    await screen.findByText("A pipeline card");

    fireEvent.click(screen.getByRole("button", { name: "rdlegion queue, 1 of 3 slots occupied" }));

    expect(screen.getByText("2 slots empty")).toBeTruthy();
    expect(screen.getByText("Machine limit reached · Waiting for active goal")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Removed task" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-removed" });
  });

  it("runs and clears next with a per-card lock and replaces selection from the fresh snapshot", async () => {
    const cards = [
      makeCard({ id: "first", title: "First task" }),
      makeCard({ id: "second", title: "Second task" }),
    ];
    let nextCardId: string | null = "second";
    const finishes: Array<() => void> = [];
    const listCards = vi.fn(() => ({
      cards,
      queue: [makeMachineQueue({
        waiting: cards.map((card) => ({
          cardId: card.id,
          title: card.title,
          threadId: card.intakeThreadId,
          reasons: ["Machine capacity is full"],
          canRunNext: true,
        })),
        nextCardId,
      })],
    }));
    const setRunNext = vi.fn((input: unknown) => new Promise<{ ok: true }>((resolve) => {
      const { cardId, enabled } = input as { cardId: string; enabled: boolean };
      finishes.push(() => {
        nextCardId = enabled ? cardId : null;
        resolve({ ok: true });
      });
    }));
    renderBoard({ listCards, setRunNext });
    const first = await screen.findByRole("article", { name: "First task" });
    const second = screen.getByRole("article", { name: "Second task" });
    expect(within(second).getByText("Next")).toBeTruthy();

    fireEvent.click(within(first).getByRole("button", { name: "Actions for First task" }));
    fireEvent.click(screen.getByRole("button", { name: "Run next" }));
    expect(setRunNext).toHaveBeenNthCalledWith(1, { cardId: "first", enabled: true });
    expect((within(first).getByRole("button", { name: "Actions for First task" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(first).getByRole("button", { name: "Actions for First task" }));
    expect(setRunNext).toHaveBeenCalledTimes(1);

    await act(async () => finishes.shift()!());
    await waitFor(() => expect(within(first).getByText("Next")).toBeTruthy());
    expect(within(second).queryByText("Next")).toBeNull();

    fireEvent.click(within(first).getByRole("button", { name: "Actions for First task" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear run next" }));
    expect(setRunNext).toHaveBeenNthCalledWith(2, { cardId: "first", enabled: false });
    expect((within(first).getByRole("button", { name: "Actions for First task" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => finishes.shift()!());
    await waitFor(() => expect(within(first).queryByText("Next")).toBeNull());
  });

  it("filters attention, queue, and stage without including saved, held, or completed work", async () => {
    renderBoard({
      cards: [
        makeCard({ id: "waiting", title: "Queued review", column: "reviewing", reportSignal: "working" }),
        makeCard({ id: "attention", title: "Choose behavior", column: "implementing", needsUser: true, attentionReason: "Pick fallback" }),
        makeCard({ id: "paused", title: "Paused task", runState: "paused", needsUser: true }),
        makeCard({ id: "saved", title: "Saved task", startRequested: false, needsUser: true }),
        makeCard({ id: "done", title: "Completed task", column: "done", needsUser: true }),
      ],
      queue: waitingQueue(["waiting", "paused", "saved", "done"]),
    });
    await screen.findByRole("article", { name: "Queued review" });
    expect(screen.getByRole("button", { name: "Needs you 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queued 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Needs you 1" }));
    expect(screen.getAllByRole("article").map((row) => row.getAttribute("aria-label"))).toEqual(["Choose behavior"]);
    fireEvent.click(screen.getByRole("button", { name: "Queued 1" }));
    expect(screen.getAllByRole("article").map((row) => row.getAttribute("aria-label"))).toEqual(["Queued review"]);
    expect(within(screen.getByRole("article", { name: "Queued review" })).getByText("Machine capacity is full")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by stage" }), { target: { value: "planning" } });
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show open tasks" }));
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect((screen.getByRole("combobox", { name: "Filter by stage" }) as HTMLSelectElement).value).toBe("all");
  });

  it("keeps list order stable when realtime reports arrive in another order", async () => {
    const older = makeCard({ id: "older", title: "Older", createdAt: 10 });
    const newer = makeCard({ id: "newer", title: "Newer", createdAt: 20 });
    let cards = [older, newer];
    const { slot } = renderBoard({ listCards: vi.fn(() => ({ cards, queue: [] })) });
    await screen.findByRole("article", { name: "Older" });
    expect(screen.getAllByRole("article").map((row) => row.getAttribute("aria-label"))).toEqual(["Newer", "Older"]);
    cards = [{ ...older, updatedAt: 200, column: "reviewing" }, newer];
    await slot.behavior.emitRealtime("cards:changed", {});
    expect(screen.getAllByRole("article").map((row) => row.getAttribute("aria-label"))).toEqual(["Newer", "Older"]);
  });

  it("keeps details current and closes them when the task disappears", async () => {
    let cards = [makeCard({ intakeThreadId: "intake", leadThreadId: "lead", ownerRole: "lead", column: "implementing", body: "Full task context", lead: DEFAULT_EXECUTION.lead })];
    const { slot } = renderBoard({ listCards: vi.fn(() => ({ cards, queue: [] })) });
    await screen.findByRole("article", { name: "A pipeline card" });
    fireEvent.click(screen.getByRole("button", { name: "A pipeline card" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "lead" });
    fireEvent.click(screen.getByRole("button", { name: "Details for A pipeline card" }));
    const detail = screen.getByRole("dialog");
    expect(within(detail).getByText("Full task context")).toBeTruthy();
    expect(within(detail).getByText(/gpt-5.6-sol/)).toBeTruthy();
    cards = [{ ...cards[0]!, column: "reviewing", needsUser: true, attentionReason: "Review this implementation" }];
    await slot.behavior.emitRealtime("cards:changed", {});
    await waitFor(() => expect(within(detail).getByText("Review this implementation")).toBeTruthy());
    expect(within(detail).getByText("Reviewing", { selector: "dd" })).toBeTruthy();
    cards = [];
    await slot.behavior.emitRealtime("cards:changed", {});
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens saved task details from its title and closes them on project switch", async () => {
    renderBoard({
      projects: [{ id: "proj_1", name: "One" }, { id: "proj_2", name: "Two" }],
      listCards: vi.fn((input: { projectId: string }) => ({ cards: [makeCard({ projectId: input.projectId, startRequested: false, intakeThreadId: null })], queue: [] })),
    });
    fireEvent.click(await screen.findByRole("button", { name: "A pipeline card" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Project", hidden: true }), { target: { value: "proj_2" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: /^Open/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("can move to a hidden empty stage through the action menu", async () => {
    const moveCard = vi.fn(() => makeCard({ column: "qa" }));
    renderBoard({ moveCard });
    await screen.findByRole("article", { name: "A pipeline card" });
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.queryByRole("region", { name: "QA" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for A pipeline card" }));
    const move = screen.getByRole("combobox", { name: "Move A pipeline card" });
    expect(within(move).getAllByRole("option").map((option) => option.textContent)).toEqual(COLUMNS.map((column) => COLUMN_LABELS[column]));
    fireEvent.change(move, { target: { value: "qa" } });
    await waitFor(() => expect(moveCard).toHaveBeenCalledExactlyOnceWith({ cardId: "card_1", column: "qa" }));
  });


  it("shows a failed detail action inside the dialog and releases its pending lock", async () => {
    const pauseCard = vi.fn(async () => { throw new Error("Cannot pause this task"); });
    renderBoard({ pauseCard });
    fireEvent.click(await screen.findByRole("button", { name: "Details for A pipeline card" }));
    const detail = screen.getByRole("dialog");
    fireEvent.click(within(detail).getByRole("button", { name: "Pause" }));
    expect((await within(detail).findByRole("alert")).textContent).toBe("Cannot pause this task");
    expect((within(detail).getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(false);
    expect(pauseCard).toHaveBeenCalledExactlyOnceWith({ cardId: "card_1" });
  });

});
