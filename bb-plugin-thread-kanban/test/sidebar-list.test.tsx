// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { PluginThreadListProps } from "@bb/plugin-sdk/app";
import {
  configureFakeSdk,
  registrations,
  rpcCalls,
  sidebarActionCalls,
} from "./sdk-fake";
import { DAY, NOW, thread } from "./fixtures";
// Importing the plugin entry is what registers the slots, exactly as bb loads
// it — so these tests exercise the component the host would actually mount.
import "@/app";

const list = registrations.threadLists[0]!;

afterEach(cleanup);

function renderList(props: Partial<PluginThreadListProps> = {}) {
  const List = list.component;
  return render(
    <List
      activeThreadId={null}
      activeProjectId={null}
      isCompactViewport={false}
      onNavigate={() => {}}
      searchQuery=""
      {...props}
    />,
  );
}

describe("thread list registration", () => {
  it("registers one sidebar list the Appearance picker can name", () => {
    expect(registrations.threadLists).toHaveLength(1);
    expect(list.id).toBe("board");
    expect(list.title).toBeTruthy();
    expect(list.description).toBeTruthy();
  });
});

describe("BoardSidebar host contract", () => {
  // The DOM contract behind bb's numbered thread shortcuts and
  // thread.next/previous. Dropping these attributes silently breaks them.
  it("marks every row as a host shortcut target", async () => {
    configureFakeSdk({ threads: [thread("thr_x", { title: "Shortcut me" })] });
    renderList();

    const row = await screen.findByRole("link", { name: "Shortcut me" });
    expect(row.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    expect(row.getAttribute("data-sidebar-thread-id")).toBe("thr_x");
  });

  // No split from the sidebar: opening a thread must not re-split the panes,
  // which is the entire reason this surface exists.
  it("opens a thread plainly and closes the mobile drawer", async () => {
    configureFakeSdk({ threads: [thread("thr_open", { title: "Open me" })] });
    let navigated = 0;
    renderList({ onNavigate: () => (navigated += 1) });

    fireEvent.click(await screen.findByRole("link", { name: "Open me" }));

    expect(sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_open",
      options: undefined,
    });
    expect(navigated).toBe(1);
  });

  it("marks the route's thread as the active row", async () => {
    configureFakeSdk({
      threads: [thread("a", { title: "Active" }), thread("b", { title: "Idle" })],
    });
    renderList({ activeThreadId: "a" });

    const active = (await screen.findByRole("link", { name: "Active" }))
      .parentElement!;
    expect(active.className).toContain("bg-sidebar-accent");
  });

  it("filters by the host's search query and ships no search box", async () => {
    configureFakeSdk({
      threads: [
        thread("a", { title: "Sidebar work" }),
        thread("b", { title: "Something else" }),
      ],
    });
    renderList({ searchQuery: "sidebar" });

    expect(await screen.findByText("Sidebar work")).toBeDefined();
    expect(screen.queryByText("Something else")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  // activeProjectId is the route's project, not a scope control: honoring it
  // would re-scope the whole board every time the user opens a thread.
  it("keeps its own project scope instead of following the route", async () => {
    configureFakeSdk({
      threads: [
        thread("a", { title: "In bb", projectId: "project-1" }),
        thread("b", { title: "In other", projectId: "project-2" }),
      ],
      projects: [
        { id: "project-1", name: "bb", isPersonal: false },
        { id: "project-2", name: "other", isPersonal: false },
      ],
    });
    renderList({ activeProjectId: "project-2" });

    expect(await screen.findByText("In bb")).toBeDefined();
    expect(screen.getByText("In other")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Filter by project"), {
      target: { value: "project-2" },
    });
    expect(screen.queryByText("In bb")).toBeNull();
    expect(screen.getByText("In other")).toBeDefined();
  });
});

describe("BoardSidebar sections", () => {
  it("hides Pinned until something is pinned", async () => {
    configureFakeSdk({ threads: [thread("a", { title: "Plain" })] });
    renderList();

    await screen.findByText("Plain");
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();

    cleanup();
    configureFakeSdk({
      threads: [
        thread("a", { title: "Plain" }),
        thread("b", { title: "Stuck", isPinned: true }),
      ],
    });
    renderList();

    const priority = await screen.findByRole("region", { name: "Pinned" });
    expect(within(priority).getByText("Stuck")).toBeDefined();
  });

  it("collapses settled threads behind a count until expanded", async () => {
    configureFakeSdk({
      threads: [thread("thr_done", { title: "Finished work" })],
      overrides: [
        { threadId: "thr_done", override: "settled", at: NOW + DAY },
      ],
    });
    renderList();

    const settled = await screen.findByRole("region", { name: "Settled" });
    expect(within(settled).getByText("Settled (1)")).toBeDefined();
    expect(screen.queryByText("Finished work")).toBeNull();

    fireEvent.click(within(settled).getByRole("button"));
    expect(within(settled).getByText("Finished work")).toBeDefined();
  });

  it("offers Settle only on a thread that may settle", async () => {
    configureFakeSdk({
      threads: [
        thread("quiet", { title: "Quiet" }),
        thread("busy", { title: "Busy", indicator: "runtime" }),
      ],
    });
    renderList();

    const quiet = (await screen.findByRole("link", { name: "Quiet" }))
      .parentElement!;
    expect(within(quiet).getByText("Settle")).toBeDefined();

    const busy = screen.getByRole("link", { name: "Busy" }).parentElement!;
    expect(within(busy).queryByText("Settle")).toBeNull();

    fireEvent.click(within(quiet).getByText("Settle"));
    await waitFor(() =>
      expect(rpcCalls).toContainEqual({
        method: "settle",
        input: { threadId: "quiet" },
      }),
    );
  });

  it("nests subagents under their thread behind the expand control", async () => {
    configureFakeSdk({
      threads: [
        thread("root", { title: "Parent" }),
        thread("child", { title: "Subagent", parentThreadId: "root" }),
      ],
    });
    renderList();

    await screen.findByText("Parent");
    expect(screen.queryByText("Subagent")).toBeNull();

    fireEvent.click(screen.getByLabelText("Expand 1 subagents"));
    expect(screen.getByText("Subagent")).toBeDefined();
  });
});

// A row the board decided to show must not be swallowed by a collapsed
// parent or a collapsed shelf — the user has no way to know it is there.
describe("BoardSidebar reveals hidden rows", () => {
  const tree = () => [
    thread("root", { title: "Parent" }),
    thread("child", { title: "Subagent", parentThreadId: "root" }),
  ];

  it("opens the active thread's ancestors on mount", async () => {
    configureFakeSdk({ threads: tree() });
    renderList({ activeThreadId: "child" });

    expect(await screen.findByText("Subagent")).toBeDefined();
  });

  it("opens the path to a match that only a subagent satisfies", async () => {
    configureFakeSdk({ threads: tree() });
    renderList({ searchQuery: "subagent" });

    expect(await screen.findByText("Parent")).toBeDefined();
    expect(screen.getByText("Subagent")).toBeDefined();
  });

  it("shows settled matches instead of a collapsed count while searching", async () => {
    configureFakeSdk({
      threads: [thread("thr_done", { title: "Finished work" })],
      overrides: [{ threadId: "thr_done", override: "settled", at: NOW + DAY }],
    });
    renderList({ searchQuery: "finished" });

    const settled = await screen.findByRole("region", { name: "Settled" });
    expect(within(settled).getByText("Finished work")).toBeDefined();
    expect(screen.queryByText("Settled (1)")).toBeNull();
  });
});

describe("row context menu", () => {
  it("restores the thread actions a replaced sidebar takes away", async () => {
    configureFakeSdk({ threads: [thread("thr_menu", { title: "Right click me" })] });
    renderList();

    fireEvent.contextMenu(await screen.findByText("Right click me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Mark unread", "Pin", "Archive", "Delete"]);
  });

  // Deletion is recursive, so it must go through bb's own confirmation rather
  // than removing a subtree on a single click.
  it("routes deletion through the host's confirmation", async () => {
    configureFakeSdk({ threads: [thread("thr_del", { title: "Delete me" })] });
    renderList();

    fireEvent.contextMenu(await screen.findByText("Delete me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Delete"));

    await waitFor(() =>
      expect(sidebarActionCalls).toContainEqual({
        method: "requestDelete",
        threadId: "thr_del",
      }),
    );
  });
});
