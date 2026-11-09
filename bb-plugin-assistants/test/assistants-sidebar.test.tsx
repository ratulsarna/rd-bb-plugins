// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  configureFakeSdk,
  emitRealtime,
  registrations,
  rejectPendingRpc,
  resolvePendingRpc,
  rpcCalls,
  setFakeThreads,
  sidebarActionCalls,
} from "./sdk-fake";
import { project as sidebarProject, thread } from "./fixtures";
import type { BoardThread } from "inbox-core/lib/lanes";
// Importing the plugin entry is what registers the slots, exactly as bb loads
// it — so these tests exercise the component the host would actually mount,
// core's board with the Bots section composed in.
import "@/app";

// The host renders the toasts; these tests only need to see what was asked.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const list = registrations.threadLists[0]!;

afterEach(() => {
  cleanup();
  // Section collapse choices persist in localStorage; tests must not inherit
  // a choice an earlier test clicked into place.
  localStorage.clear();
});

function listElement(props: Partial<PluginThreadListProps> = {}) {
  const List = list.component;
  return (
    <List
      activeThreadId={null}
      activeProjectId={null}
      isCompactViewport={false}
      onNavigate={() => {}}
      searchQuery=""
      {...props}
    />
  );
}

function renderList(props: Partial<PluginThreadListProps> = {}) {
  return render(listElement(props));
}

describe("thread list registration", () => {
  it("registers one sidebar list the Appearance picker can name", () => {
    expect(registrations.threadLists).toHaveLength(1);
    expect(list.id).toBe("board");
    expect(list.title).toBe("Assistants");
    expect(list.description).toBeTruthy();
  });
});

// While a row menu is open, a press on the list only dismisses it. The Bots
// rows share the guard: on a phone the long-press that opened the menu
// releases into a click on the row, which must not open the thread (closing
// the drawer) or run a row control.
describe("while a row menu is open", () => {
  // fireEvent.click defaults to detail 0, which is what keyboard
  // activation sends; a finger or mouse sends detail >= 1.
  const tap = (target: HTMLElement) => {
    fireEvent.pointerDown(target);
    fireEvent.click(target, { detail: 1 });
  };
  const opens = () =>
    sidebarActionCalls.filter((c) => c.method === "open").map((c) => c.threadId);
  const openMenuOn = async (target: HTMLElement) => {
    fireEvent.contextMenu(target);
    return screen.findByRole("menu");
  };

  it("still runs the menu's own items, and guards Bots rows the same way", async () => {
    configureFakeSdk({
      projects: [sidebarProject("assist-1", "assistants"), sidebarProject("project-1", "bb")],
      threads: [
        thread("thr_a", { title: "Row A" }),
        thread("thr_bot", { title: "Sam", projectId: "assist-1" }),
      ],
    });
    renderList({ isCompactViewport: true });
    const bot = within(await screen.findByRole("region", { name: "Bots" })).getByRole("link", {
      name: /^Sam/,
    });

    await openMenuOn(bot);
    fireEvent.click(bot, { detail: 1 });
    expect(opens()).toEqual([]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    const menu = await openMenuOn(screen.getByText("Row A"));
    tap(within(menu).getByText("Settle"));
    await waitFor(() =>
      expect(rpcCalls).toContainEqual({ method: "settle", input: { threadId: "thr_a" } }),
    );
  });
});

describe("Bots section", () => {
  it("keeps a second case-variant Assistants project's conversations and filter accessible", async () => {
    configureFakeSdk({
      projects: [
        sidebarProject("assist-1", "Assistants"),
        sidebarProject("assist-2", "ASSISTANTS"),
        sidebarProject("project-1", "Work"),
      ],
      threads: [
        thread("first", { title: "First fleet", projectId: "assist-1" }),
        thread("second-a", { title: "Second fleet A", projectId: "assist-2" }),
        thread("second-b", { title: "Second fleet B", projectId: "assist-2" }),
        thread("work", { title: "Other work" }),
      ],
    });
    renderList();
    const bots = await screen.findByRole("region", { name: "Bots" });
    const inbox = screen.getByRole("region", { name: "Inbox" });
    expect(within(bots).getByLabelText("First fleet")).toBeDefined();
    expect(within(inbox).queryByText("First fleet")).toBeNull();
    expect(within(inbox).getByText("Second fleet A")).toBeDefined();
    expect(within(inbox).getByText("Second fleet B")).toBeDefined();
    const filter = screen.getByRole("combobox", { name: "Filter by project" });
    expect(within(filter).queryByRole("option", { name: "Assistants" })).toBeNull();
    expect(within(filter).getByRole("option", { name: "ASSISTANTS" }).getAttribute("value")).toBe("assist-2");
    fireEvent.change(filter, { target: { value: "assist-2" } });
    expect(within(inbox).getByText("Second fleet A")).toBeDefined();
    expect(within(inbox).getByText("Second fleet B")).toBeDefined();
    expect(within(inbox).queryByText("Other work")).toBeNull();
    fireEvent.click(within(inbox).getByRole("link", { name: "Second fleet B" }));
    expect(sidebarActionCalls).toContainEqual({ method: "open", threadId: "second-b", options: undefined });
    expect(within(bots).getByLabelText("First fleet")).toBeDefined();
  });

  it("keeps the same assistant's conversations on different machines visible with shared subtitles and distinct machine labels", async () => {
    configureFakeSdk({
      projects: [sidebarProject("assist-1", "assistants")],
      threads: [
        Object.assign(thread("sam-server", { title: "Sam", projectId: "assist-1", host: { id: "srv", name: "Server" }, environment: { id: "env-server" } as BoardThread["environment"] }), { updatedAt: 200 }),
        Object.assign(thread("sam-mac", { title: "Sam", projectId: "assist-1", host: { id: "mac", name: "Mac" }, environment: { id: "env-mac" } as BoardThread["environment"] }), { updatedAt: 100 }),
      ],
      assistantIdentities: { "env-server": "assist-1:sam", "env-mac": "assist-1:sam" },
      assistantOrder: ["assist-1:sam"],
      subtitles: [{ identity: "assist-1:sam", subtitle: "Chief of staff" }],
    });
    renderList();
    const bots = await screen.findByRole("region", { name: "Bots" });
    expect(await within(bots).findByLabelText("Sam — Server")).toBeDefined();
    expect(within(bots).getByLabelText("Sam — Mac")).toBeDefined();
    await waitFor(() => expect(within(bots).getAllByText("Chief of staff")).toHaveLength(2));
    expect(Array.from(bots.querySelectorAll("[data-sidebar-thread-id]")).map((row) => row.getAttribute("data-sidebar-thread-id"))).toEqual(["sam-server", "sam-mac"]);
  });

  const fleet = () => [
    thread("thr_sam", {
      title: "Sam",
      projectId: "assist-1",
      environment: { id: "env-sam" } as BoardThread["environment"],
    }),
    thread("thr_hands", {
      title: "Hands",
      projectId: "assist-1",
      environment: { id: "env-hands" } as BoardThread["environment"],
    }),
    thread("thr_work", { title: "Plain work" }),
  ];

  function fleetSidebar(assistantOrder: string[] = []) {
    configureFakeSdk({
      threads: fleet(),
      projects: [
        sidebarProject("project-1", "bb"),
        sidebarProject("assist-1", "assistants"),
      ],
      assistantOrder,
    });
    return renderList();
  }

  it("shows assistants under Bots in the stored order, never in Inbox", async () => {
    fleetSidebar(["env-hands", "env-sam"]);

    const bots = await screen.findByRole("region", { name: "Bots" });
    await waitFor(() => {
      const rows = Array.from(bots.querySelectorAll("[data-sidebar-thread-id]"));
      expect(rows.map((row) => row.getAttribute("data-sidebar-thread-id"))).toEqual(
        ["thr_hands", "thr_sam"],
      );
    });

    const inbox = screen.getByRole("region", { name: "Inbox" });
    expect(within(inbox).queryByText("Sam")).toBeNull();
    expect(within(inbox).getByText("Plain work")).toBeDefined();
  });

  it("keeps a collapsed section collapsed across a remount", async () => {
    fleetSidebar();
    const bots = await screen.findByRole("region", { name: "Bots" });
    fireEvent.click(
      within(bots).getByRole("button", { name: /Bots/, expanded: true }),
    );
    expect(within(bots).queryByText("Sam")).toBeNull();
    expect(within(bots).getByText("Bots (2)")).toBeDefined();

    cleanup();
    fleetSidebar();
    const remounted = await screen.findByRole("region", { name: "Bots" });
    expect(within(remounted).getByText("Bots (2)")).toBeDefined();
    expect(within(remounted).queryByText("Sam")).toBeNull();
  });

  it("opens an assistant thread on click", async () => {
    fleetSidebar();
    const bots = await screen.findByRole("region", { name: "Bots" });
    fireEvent.click(within(bots).getByLabelText("Sam"));
    expect(sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_sam",
      options: undefined,
    });
  });

  it("keeps the rows in place but undraggable while a new bot's identity is read", async () => {
    configureFakeSdk({
      threads: fleet(),
      projects: [
        sidebarProject("project-1", "bb"),
        sidebarProject("assist-1", "assistants"),
      ],
      assistantOrder: ["proj_x:hands", "proj_x:sam"],
      deferRpc: ["assistantIdentities"],
    });
    const view = renderList();
    const identities = (...rows: [string, string][]) => ({
      rows: rows.map(([environmentId, identity]) => ({ environmentId, identity })),
    });
    const ids = (bots: HTMLElement) =>
      Array.from(bots.querySelectorAll("[data-sidebar-thread-id]")).map((row) =>
        row.getAttribute("data-sidebar-thread-id"),
      );
    await waitFor(() =>
      resolvePendingRpc("assistantIdentities", "oldest",
        identities(["env-sam", "proj_x:sam"], ["env-hands", "proj_x:hands"])),
    );
    const bots = await screen.findByRole("region", { name: "Bots" });
    await waitFor(() =>
      expect(bots.querySelector('[aria-roledescription="sortable"]')).not.toBeNull(),
    );

    // A drag before the new row's identity lands would store its environment
    // id over the saved order, so no row is sortable until it does.
    setFakeThreads([
      ...fleet(),
      thread("thr_new", {
        title: "New",
        projectId: "assist-1",
        environment: { id: "env-new" } as BoardThread["environment"],
      }),
    ]);
    view.rerender(listElement());
    await waitFor(() => expect(ids(bots)).toEqual(["thr_hands", "thr_sam", "thr_new"]));
    expect(bots.querySelector('[aria-roledescription="sortable"]')).toBeNull();

    await waitFor(() =>
      resolvePendingRpc("assistantIdentities", "oldest", identities(
        ["env-sam", "proj_x:sam"], ["env-hands", "proj_x:hands"], ["env-new", "proj_x:new"],
      )),
    );
    await waitFor(() =>
      expect(bots.querySelector('[aria-roledescription="sortable"]')).not.toBeNull(),
    );
    expect(ids(bots)).toEqual(["thr_hands", "thr_sam", "thr_new"]);
  });

  // The machine switch in real life: the thread reattaches to the same home
  // on another machine and lands in a brand-new environment, but the
  // identity underneath is unchanged — so the subtitle survives.
  it("keeps a subtitle across a reattach to a new environment", async () => {
    configureFakeSdk({
      threads: [
        thread("thr_sam", {
          title: "Sam",
          projectId: "assist-1",
          environment: { id: "env-sam-mac" } as BoardThread["environment"],
        }),
      ],
      projects: [
        sidebarProject("project-1", "bb"),
        sidebarProject("assist-1", "assistants"),
      ],
      assistantIdentities: { "env-sam-mac": "proj_x:sam" },
      subtitles: [{ identity: "proj_x:sam", subtitle: "Chief of staff" }],
    });
    renderList();

    const bots = await screen.findByRole("region", { name: "Bots" });
    expect(await within(bots).findByText("Chief of staff")).toBeDefined();
  });

  it("marks an assistant whose memory has a warning, and only that one, on any machine", async () => {
    configureFakeSdk({
      threads: [
        thread("thr_sam", { title: "Sam", projectId: "assist-1", environment: { id: "env-sam-mac" } as BoardThread["environment"] }),
        thread("thr_hands", { title: "Hands", projectId: "assist-1", environment: { id: "env-hands" } as BoardThread["environment"] }),
      ],
      projects: [sidebarProject("project-1", "bb"), sidebarProject("assist-1", "assistants")],
      assistantIdentities: { "env-sam-mac": "proj_x:sam", "env-hands": "proj_x:hands" },
      memoryWarnings: [
        { identity: "proj_x:sam", warning: "rotation skipped: summaries not ready" },
        { identity: "proj_x:hands", warning: null },
      ],
    });
    renderList();

    const bots = await screen.findByRole("region", { name: "Bots" });
    const mark = await within(bots).findByRole("img", { name: "Memory warning: rotation skipped: summaries not ready" });
    expect(mark.closest("li")!.querySelector("[data-sidebar-thread-id]")!.getAttribute("data-sidebar-thread-id")).toBe("thr_sam");
    expect(within(bots).getAllByRole("img", { name: /^Memory warning/ })).toHaveLength(1);
  });

  it("orders rows by identity even when every row changed environment", async () => {
    const bot = (id: string, envId: string) =>
      thread(id, {
        title: id,
        projectId: "assist-1",
        environment: { id: envId } as BoardThread["environment"],
      });
    configureFakeSdk({
      threads: [bot("thr_sam", "env-sam-2"), bot("thr_hands", "env-hands-2")],
      projects: [
        sidebarProject("project-1", "bb"),
        sidebarProject("assist-1", "assistants"),
      ],
      assistantOrder: ["proj_x:hands", "proj_x:sam"],
      assistantIdentities: {
        "env-sam-2": "proj_x:sam",
        "env-hands-2": "proj_x:hands",
      },
    });
    renderList();

    const bots = await screen.findByRole("region", { name: "Bots" });
    await waitFor(() => {
      const rows = Array.from(bots.querySelectorAll("[data-sidebar-thread-id]"));
      expect(rows.map((row) => row.getAttribute("data-sidebar-thread-id"))).toEqual(
        ["thr_hands", "thr_sam"],
      );
    });
  });
});

describe("Bots hidden when collapsed", () => {
  const crowd = (overrides: Record<string, Partial<BoardThread>> = {}) =>
    ["one", "two", "three", "four"].map((name) =>
      thread(`thr_${name}`, {
        title: name,
        projectId: "assist-1",
        environment: { id: `env-${name}` } as BoardThread["environment"],
        ...overrides[name],
      }),
    );

  function crowdedSidebar(
    hiddenAssistants: string[],
    props: Partial<PluginThreadListProps> = {},
    threads = crowd(),
  ) {
    configureFakeSdk({
      threads,
      projects: [
        sidebarProject("project-1", "bb"),
        sidebarProject("assist-1", "assistants"),
      ],
      assistantOrder: ["env-one", "env-two", "env-three", "env-four"],
      hiddenAssistants,
    });
    return renderList(props);
  }

  const botIds = (bots: HTMLElement) =>
    Array.from(bots.querySelectorAll("[data-sidebar-thread-id]")).map((row) =>
      row.getAttribute("data-sidebar-thread-id"),
    );

  it("shows nothing, Inbox included, until the order, the hidden bots, the subtitles and the identities have all landed", async () => {
    configureFakeSdk({
      threads: [...crowd(), thread("thr_work", { title: "Plain work" })],
      projects: [
        sidebarProject("project-1", "bb"),
        sidebarProject("assist-1", "assistants"),
      ],
      assistantOrder: ["env-four", "env-three", "env-two", "env-one"],
      hiddenAssistants: ["env-two"],
      deferRpc: ["assistantOrder", "hiddenAssistants", "listAssistantSubtitles", "assistantIdentities"],
    });
    renderList();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const answers: [string, unknown][] = [
      ["assistantOrder", { ids: ["env-four", "env-three", "env-two", "env-one"] }],
      ["hiddenAssistants", { ids: ["env-two"] }],
    ];
    for (const [method, answer] of answers) {
      expect(screen.queryByRole("region", { name: "Bots" })).toBeNull();
      expect(screen.queryByText("Plain work")).toBeNull();
      await act(async () => resolvePendingRpc(method, "oldest", answer));
    }
    await act(async () =>
      rejectPendingRpc("assistantIdentities", "oldest", new Error("unresolved")),
    );
    expect(screen.queryByRole("region", { name: "Bots" })).toBeNull();
    expect(screen.queryByText("Plain work")).toBeNull();
    await act(async () =>
      resolvePendingRpc("listAssistantSubtitles", "oldest", {
        rows: [{ identity: "env-one", subtitle: "Builds plugins" }],
      }),
    );

    const bots = await screen.findByRole("region", { name: "Bots" });
    expect(botIds(bots)).toEqual(["thr_four", "thr_three", "thr_one"]);
    expect(within(bots).getByText("Builds plugins")).toBeDefined();
    expect(screen.getByText("Plain work")).toBeDefined();
  });

  it("waits for the identities of rows that arrive while the board still loads", async () => {
    configureFakeSdk({
      threads: [...crowd(), thread("thr_work", { title: "Plain work" })],
      projects: [
        sidebarProject("project-1", "bb"),
        sidebarProject("assist-1", "assistants"),
      ],
      assistantOrder: ["env-one", "env-two", "env-three", "env-four"],
      deferRpc: ["hiddenAssistants", "assistantIdentities"],
    });
    const view = renderList();
    await waitFor(() =>
      resolvePendingRpc("assistantIdentities", "oldest", {
        rows: ["one", "two", "three", "four"].map((name) => ({
          environmentId: `env-${name}`,
          identity: `env-${name}`,
        })),
      }),
    );

    // A hidden bot reattaches in a new environment before the board shows.
    setFakeThreads([
      ...crowd(),
      thread("thr_five", {
        title: "five",
        projectId: "assist-1",
        environment: { id: "env-five-new" } as BoardThread["environment"],
      }),
      thread("thr_work", { title: "Plain work" }),
    ]);
    view.rerender(listElement());
    await act(async () => resolvePendingRpc("hiddenAssistants", "oldest", { ids: ["proj_x:five"] }));
    expect(screen.queryByText("Plain work")).toBeNull();

    await waitFor(() =>
      resolvePendingRpc("assistantIdentities", "newest", {
        rows: [
          ...["one", "two", "three", "four"].map((name) => ({
            environmentId: `env-${name}`,
            identity: `env-${name}`,
          })),
          { environmentId: "env-five-new", identity: "proj_x:five" },
        ],
      }),
    );
    const bots = await screen.findByRole("region", { name: "Bots" });
    expect(botIds(bots)).toEqual(["thr_one", "thr_two", "thr_three", "thr_four"]);
  });

  it("keeps the board up when the first bot arrives", async () => {
    configureFakeSdk({
      threads: [thread("thr_work", { title: "Plain work" })],
      projects: [
        sidebarProject("project-1", "bb"),
        sidebarProject("assist-1", "assistants"),
      ],
      deferRpc: ["assistantIdentities"],
    });
    const view = renderList();
    expect(await screen.findByText("Plain work")).toBeDefined();

    setFakeThreads([...crowd().slice(0, 1), thread("thr_work", { title: "Plain work" })]);
    view.rerender(listElement());
    expect(screen.getByText("Plain work")).toBeDefined();
    await waitFor(() =>
      resolvePendingRpc("assistantIdentities", "oldest", {
        rows: [{ environmentId: "env-one", identity: "env-one" }],
      }),
    );
    const bots = await screen.findByRole("region", { name: "Bots" });
    expect(botIds(bots)).toEqual(["thr_one"]);
  });

  it("shows every bot, with no Show more, until one is hidden", async () => {
    crowdedSidebar([]);
    const bots = await screen.findByRole("region", { name: "Bots" });
    await waitFor(() =>
      expect(botIds(bots)).toEqual(["thr_one", "thr_two", "thr_three", "thr_four"]),
    );
    expect(within(bots).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("hides with the eye, keeps hidden bots behind Show more, and shows them again", async () => {
    crowdedSidebar([]);
    const bots = await screen.findByRole("region", { name: "Bots" });
    const eye = await within(bots).findByRole("button", { name: "Hide two when collapsed" });
    expect(eye.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(eye);
    await waitFor(() =>
      expect(rpcCalls.some((call) => call.method === "setAssistantHidden")).toBe(true),
    );
    act(() => emitRealtime("assistant-hidden"));
    await waitFor(() => expect(botIds(bots)).toEqual(["thr_one", "thr_three", "thr_four"]));

    fireEvent.click(within(bots).getByRole("button", { name: "Show more" }));
    expect(botIds(bots)).toEqual(["thr_one", "thr_two", "thr_three", "thr_four"]);
    const hiddenEye = within(bots).getByRole("button", { name: "Hide two when collapsed" });
    expect(hiddenEye.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(bots).getByRole("button", { name: "Show less" }));
    expect(botIds(bots)).toEqual(["thr_one", "thr_three", "thr_four"]);

    fireEvent.click(within(bots).getByRole("button", { name: "Show more" }));
    fireEvent.click(within(bots).getByRole("button", { name: "Hide two when collapsed" }));
    act(() => emitRealtime("assistant-hidden"));
    await waitFor(() =>
      expect(within(bots).queryByRole("button", { name: /Show (more|less)/ })).toBeNull(),
    );
    expect(botIds(bots)).toEqual(["thr_one", "thr_two", "thr_three", "thr_four"]);
  });

  it("brings a hidden bot back while it is unread, waiting or working, and tucks it once quiet", async () => {
    const view = crowdedSidebar(["env-two", "env-three", "env-four"], {}, crowd({
      two: { isUnread: true },
      three: { indicator: "waiting-for-input" },
      four: { indicator: "runtime" },
    }));
    const bots = await screen.findByRole("region", { name: "Bots" });
    await waitFor(() =>
      expect(botIds(bots)).toEqual(["thr_one", "thr_two", "thr_three", "thr_four"]),
    );
    expect(within(bots).queryByRole("button", { name: "Show more" })).toBeNull();

    setFakeThreads(crowd({ three: { indicator: "waiting-for-input" } }));
    view.rerender(listElement());
    expect(botIds(bots)).toEqual(["thr_one", "thr_three"]);
    expect(within(bots).getByRole("button", { name: "Show more" })).toBeDefined();
  });

  it("keeps the open bot in place after reading it", async () => {
    crowdedSidebar(["env-two"], { activeThreadId: "thr_two" });
    const bots = await screen.findByRole("region", { name: "Bots" });
    await waitFor(() =>
      expect(within(bots).getByRole("button", { name: "Hide two when collapsed" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(botIds(bots)).toEqual(["thr_one", "thr_two", "thr_three", "thr_four"]);
  });

  it("lets a search reach a hidden bot", async () => {
    crowdedSidebar(["env-four"], { searchQuery: "four" });
    const bots = await screen.findByRole("region", { name: "Bots" });
    await waitFor(() => expect(botIds(bots)).toEqual(["thr_four"]));
    expect(within(bots).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("hides every machine's row of one assistant together", async () => {
    configureFakeSdk({
      projects: [sidebarProject("assist-1", "assistants")],
      threads: ["sam-server", "sam-mac", "forge-server"].map((id) =>
        thread(id, {
          title: id.startsWith("sam") ? "Sam" : "Forge",
          projectId: "assist-1",
          host: { id: id.endsWith("server") ? "srv" : "mac", name: id.endsWith("server") ? "Server" : "Mac" },
          environment: { id } as BoardThread["environment"],
        }),
      ),
      assistantIdentities: { "sam-server": "assist-1:sam", "sam-mac": "assist-1:sam", "forge-server": "assist-1:forge" },
      assistantOrder: ["assist-1:sam", "assist-1:forge"],
    });
    renderList();
    const bots = await screen.findByRole("region", { name: "Bots" });
    fireEvent.click(await within(bots).findByRole("button", { name: "Hide Sam on Mac when collapsed" }));
    await waitFor(() =>
      expect(rpcCalls.some((call) => call.method === "setAssistantHidden")).toBe(true),
    );
    act(() => emitRealtime("assistant-hidden"));
    await waitFor(() => expect(botIds(bots)).toEqual(["forge-server"]));
  });
});

describe("Bots row identity", () => {
  // An automation run spawned in an assistant's home shares its environment.
  // Rows must key by thread id: keyed by environment, React's reconciliation
  // strands a ghost row when the run archives itself.
  const chimp = () =>
    ({
      ...thread("thr_chimp", {
        title: "Chimp",
        projectId: "assist-1",
        environment: { id: "env-chimp" } as BoardThread["environment"],
      }),
      updatedAt: 100,
    }) as BoardThread;
  const sweepRun = (overrides: Partial<BoardThread> = {}) =>
    ({
      ...thread("thr_sweep", {
        title: "Email Sweep",
        projectId: "assist-1",
        environment: { id: "env-chimp" } as BoardThread["environment"],
        ...overrides,
      }),
      updatedAt: 200,
    }) as BoardThread;

  it("renders a run beside its assistant and drops it cleanly on archive", async () => {
    configureFakeSdk({
      threads: [chimp(), sweepRun()],
      projects: [
        sidebarProject("project-1", "bb"),
        sidebarProject("assist-1", "assistants"),
      ],
      assistantOrder: ["env-chimp"],
    });
    const view = renderList();
    const bots = await screen.findByRole("region", { name: "Bots" });
    const ids = () =>
      Array.from(bots.querySelectorAll("[data-sidebar-thread-id]")).map(
        (row) => row.getAttribute("data-sidebar-thread-id"),
      );
    expect(ids().sort()).toEqual(["thr_chimp", "thr_sweep"]);

    setFakeThreads([chimp(), sweepRun({ isArchived: true })]);
    view.rerender(listElement());
    expect(ids()).toEqual(["thr_chimp"]);
  });
});


it.each(["down", "up", "same then down"])("drags any retained conversation as one assistant group: %s", async (direction) => {
  const initial = direction === "up" ? ["assist-1:forge", "assist-1:sam"] : ["assist-1:sam", "assist-1:forge"];
  configureFakeSdk({
    projects: [sidebarProject("assist-1", "assistants")],
    threads: ["sam-server", "sam-mac", "forge-server", "forge-mac"].map((id, index) => Object.assign(thread(id, {
      title: id.startsWith("sam") ? "Sam" : "Forge", projectId: "assist-1",
      host: { id: id.endsWith("server") ? "srv" : "mac", name: id.endsWith("server") ? "Server" : "Mac" },
      environment: { id } as BoardThread["environment"],
    }), { updatedAt: 100 - index })),
    assistantIdentities: { "sam-server": "assist-1:sam", "sam-mac": "assist-1:sam", "forge-server": "assist-1:forge", "forge-mac": "assist-1:forge" },
    assistantOrder: initial,
  });
  renderList();
  const bots = await screen.findByRole("region", { name: "Bots" });
  await waitFor(() => expect(within(bots).getByLabelText("Sam — Mac").getAttribute("aria-roledescription")).toBe("sortable"));
  const ids = () => Array.from(bots.querySelectorAll("[data-sidebar-thread-id]")).map((row) => row.getAttribute("data-sidebar-thread-id"));
  await waitFor(() => expect(ids()).toHaveLength(4));
  const drag = async (activeId: string, overId: string) => {
    const links = Array.from(bots.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]"));
    links.forEach((link, index) => {
      const top = index * 48;
      link.closest("li")!.getBoundingClientRect = () => ({ x: 0, y: top, top, left: 0, right: 240, bottom: top + 48, width: 240, height: 48, toJSON: () => ({}) }) as DOMRect;
    });
    const activeIndex = links.findIndex((link) => link.getAttribute("data-sidebar-thread-id") === activeId);
    const overIndex = links.findIndex((link) => link.getAttribute("data-sidebar-thread-id") === overId);
    const active = links[activeIndex]!;
    const startY = activeIndex * 48 + 24;
    const targetY = overIndex * 48 + 24;
    fireEvent.mouseDown(active, { button: 0, buttons: 1, clientX: 20, clientY: startY });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 20, clientY: startY + 6 });
    await waitFor(() => expect(active.closest("li")!.getAttribute("data-pinned-reordering")).toBe("true"));
    fireEvent.mouseMove(document, { buttons: 1, clientX: 20, clientY: targetY });
    fireEvent.mouseUp(document, { button: 0, clientX: 20, clientY: targetY });
  };
  if (direction === "same then down") {
    await drag("sam-mac", "sam-server");
    expect(rpcCalls.filter((call) => call.method === "setAssistantOrder")).toEqual([]);
    expect(ids()).toEqual(["sam-server", "sam-mac", "forge-server", "forge-mac"]);
  }
  await drag("sam-mac", direction === "up" ? "forge-server" : "forge-mac");
  const expected = direction === "up" ? ["assist-1:sam", "assist-1:forge"] : ["assist-1:forge", "assist-1:sam"];
  await waitFor(() => expect(rpcCalls.filter((call) => call.method === "setAssistantOrder").map((call) => call.input)).toEqual([{ identities: expected }]));
  await waitFor(() => expect(ids()).toEqual(direction === "up" ? ["sam-server", "sam-mac", "forge-server", "forge-mac"] : ["forge-server", "forge-mac", "sam-server", "sam-mac"]));
});

// The keys today's build wrote: the section component used to hardcode the
// plugin id. Core's copy derives the same keys from the bundling plugin's id,
// so a user's collapsed sections survive the switch to the shared code.
describe("collapse keys carry over", () => {
  it("renders Bots and an inbox section collapsed from the keys today's build wrote", async () => {
    localStorage.setItem("assistants:collapsed:bots", "1");
    localStorage.setItem("assistants:collapsed:inbox", "1");
    configureFakeSdk({
      projects: [sidebarProject("project-1", "bb"), sidebarProject("assist-1", "assistants")],
      threads: [
        thread("thr_sam", { title: "Sam", projectId: "assist-1" }),
        thread("thr_work", { title: "Plain work" }),
      ],
    });
    renderList();

    const bots = await screen.findByRole("region", { name: "Bots" });
    expect(within(bots).getByText("Bots (1)")).toBeDefined();
    expect(within(bots).queryByText("Sam")).toBeNull();

    const inbox = screen.getByRole("region", { name: "Inbox" });
    expect(within(inbox).getByText("Inbox (1)")).toBeDefined();
    expect(within(inbox).queryByText("Plain work")).toBeNull();
  });
});
