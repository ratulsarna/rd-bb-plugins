// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
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
  resolvePendingRpc,
  rpcCalls,
  setFakePinnedOrder,
  setFakeProjects,
  setFakeThreads,
  sidebarActionCalls,
  splitPointerDownCalls,
} from "./sdk-fake";
import { DAY, HOUR, NOW, thread } from "./fixtures";
import type { BoardThread } from "@/lib/lanes";
// Importing the plugin entry is what registers the slots, exactly as bb loads
// it — so these tests exercise the component the host would actually mount.
import "@/app";

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

async function passDoubleClickWindow() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 320));
  });
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

  it("maps every supported BB provider and reserves fallback for unknown ids", async () => {
    configureFakeSdk({
      threads: [
        thread("codex", { title: "Codex row", providerId: "codex" }),
        thread("claude", {
          title: "Claude row",
          providerId: "claude-code",
        }),
        thread("pi", { title: "Pi row", providerId: "pi" }),
        thread("cursor", { title: "Cursor row", providerId: "acp-cursor" }),
        thread("grok", { title: "Grok row", providerId: "acp-grok" }),
        thread("other", { title: "Other row", providerId: "acp-custom" }),
      ],
    });
    renderList();

    for (const label of ["Codex", "Claude Code", "Pi", "Cursor", "Grok"]) {
      expect(await screen.findByRole("img", { name: label })).toBeDefined();
    }
    const fallbacks = screen.getAllByRole("img", {
      name: "Unknown provider",
    });
    expect(fallbacks).toHaveLength(1);
    const fallback = fallbacks[0]!;
    expect(fallback.querySelector("title")?.textContent).toBe("acp-custom");
    expect(fallback.getAttribute("class")).toContain(
      "text-muted-foreground/50",
    );
  });

  it("keeps clipped labels hoverable and row-opening without weakening PR isolation", async () => {
    const title = "A thread title long enough to need clipping";
    const projectName = "A project name long enough to need clipping";
    const machineName = "A machine name long enough to use the flexible space";
    configureFakeSdk({
      projects: [{ id: "project-long", name: projectName, isPersonal: false }],
      threads: [
        thread("metadata", {
          title,
          projectId: "project-long",
          host: { id: "host-1", name: machineName },
          indicator: "runtime",
        }),
      ],
      pullRequests: {
        metadata: {
          number: 41,
          title: "Hover target fix",
          url: "https://example.test/pulls/41",
          state: "open",
          attention: "ready_to_merge",
        },
      },
    });
    let navigated = 0;
    renderList({ onNavigate: () => (navigated += 1) });

    const rowLink = await screen.findByRole("link", { name: title });
    const row = rowLink.parentElement!;
    const titleLabel = within(row).getByTitle(title);
    const project = within(row).getByTitle(`Project: ${projectName}`);
    const machine = within(row).getByTitle(`Machine: ${machineName}`);
    for (const label of [titleLabel, project, machine]) {
      expect(label.className).toContain("pointer-events-auto");
      expect(label.className).not.toContain("pointer-events-none");
    }
    expect(titleLabel.className).toContain("truncate");
    expect(project.className).toContain("max-w-[45%]");
    expect(project.className).toContain("truncate");
    expect(machine.className).toContain("min-w-0");
    expect(machine.className).toContain("flex-1");
    expect(machine.className).toContain("truncate");
    expect(project.parentElement?.className).toContain("whitespace-nowrap");
    expect(within(row).getByText("Running").className).toContain("shrink-0");

    fireEvent.click(rowLink);
    fireEvent.click(titleLabel);
    fireEvent.click(project);
    fireEvent.click(machine);
    await passDoubleClickWindow();
    const opensBeforePr = sidebarActionCalls.filter(
      (call) => call.method === "open",
    );
    expect(opensBeforePr).toHaveLength(4);
    expect(opensBeforePr.every((call) => call.threadId === "metadata")).toBe(
      true,
    );
    expect(navigated).toBe(4);

    const prLink = within(row).getByRole("link", {
      name: "Open pull request #41: Hover target fix",
    });
    expect(prLink.getAttribute("href")).toBe(
      "https://example.test/pulls/41",
    );
    fireEvent.click(prLink);
    expect(
      sidebarActionCalls.filter((call) => call.method === "open"),
    ).toHaveLength(4);
    expect(navigated).toBe(4);
  });

  it("links only open and draft PRs without opening the thread row", async () => {
    configureFakeSdk({
      threads: [
        thread("open", { title: "Open PR row" }),
        thread("draft", { title: "Draft PR row" }),
        thread("merged", { title: "Merged PR row" }),
        thread("closed", { title: "Closed PR row" }),
      ],
      pullRequests: {
        open: {
          number: 42,
          title: "Ready change",
          url: "https://example.test/pulls/42",
          state: "open",
          attention: "ready_to_merge",
        },
        draft: {
          number: 43,
          title: "Work in progress",
          url: "https://example.test/pulls/43",
          state: "draft",
          attention: "draft",
        },
        merged: {
          number: 44,
          title: "Merged change",
          url: "https://example.test/pulls/44",
          state: "merged",
          attention: "merged",
        },
        closed: {
          number: 45,
          title: "Closed change",
          url: "https://example.test/pulls/45",
          state: "closed",
          attention: "closed",
        },
      },
    });
    let navigated = 0;
    renderList({
      searchQuery: "PR row",
      onNavigate: () => (navigated += 1),
    });

    const openPr = await screen.findByRole("link", {
      name: "Open pull request #42: Ready change",
    });
    const draftPr = screen.getByRole("link", {
      name: "Draft pull request #43: Work in progress",
    });
    expect(openPr.getAttribute("href")).toBe("https://example.test/pulls/42");
    expect(draftPr.getAttribute("href")).toBe("https://example.test/pulls/43");
    expect(openPr.getAttribute("target")).toBe("_blank");
    expect(openPr.className).toContain("pointer-events-auto");

    const mergedRow = screen.getByRole("link", { name: "Merged PR row" })
      .parentElement!;
    const closedRow = screen.getByRole("link", { name: "Closed PR row" })
      .parentElement!;
    expect(
      within(mergedRow).queryByRole("link", { name: /pull request/i }),
    ).toBeNull();
    expect(
      within(closedRow).queryByRole("link", { name: /pull request/i }),
    ).toBeNull();

    fireEvent.click(openPr);
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
    );
    expect(navigated).toBe(0);
  });

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

  it("renames a thread inline after a desktop double-click", async () => {
    configureFakeSdk({
      threads: [thread("thr_rename", { title: "Old title" })],
    });
    let navigated = 0;
    renderList({ onNavigate: () => (navigated += 1) });

    const title = await screen.findByText("Old title");
    fireEvent.click(title);
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
    );
    fireEvent.click(title);
    const input = screen.getByRole("textbox", { name: "Rename Old title" });
    expect(document.activeElement).toBe(input);
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
    );
    expect(navigated).toBe(0);

    fireEvent.change(input, { target: { value: "  Better title  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sidebarActionCalls).toContainEqual({
      method: "rename",
      threadId: "thr_rename",
      options: "Better title",
    });
  });

  it("does not navigate away from a searched nested row before rename starts", async () => {
    configureFakeSdk({
      threads: [
        thread("parent", { title: "Parent" }),
        thread("nested", {
          title: "Nested search match",
          parentThreadId: "parent",
        }),
      ],
    });
    let navigated = 0;
    renderList({
      searchQuery: "search match",
      onNavigate: () => (navigated += 1),
    });

    const title = await screen.findByText("Nested search match");
    fireEvent.click(title);
    fireEvent.click(title);

    expect(
      screen.getByRole("textbox", { name: "Rename Nested search match" }),
    ).toBeDefined();
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
    );
    expect(navigated).toBe(0);
  });

  it("opens a compact-view thread after one title tap", async () => {
    configureFakeSdk({
      threads: [thread("thr_mobile_open", { title: "Tap title" })],
    });
    let navigated = 0;
    renderList({
      isCompactViewport: true,
      onNavigate: () => (navigated += 1),
    });

    fireEvent.click(await screen.findByText("Tap title"));

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
    );
    await passDoubleClickWindow();
    expect(sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_mobile_open",
      options: undefined,
    });
    expect(navigated).toBe(1);
  });

  it("requires two compact-view title taps to rename", async () => {
    configureFakeSdk({
      threads: [thread("thr_mobile_rename", { title: "Double tap title" })],
    });
    let navigated = 0;
    renderList({
      isCompactViewport: true,
      onNavigate: () => (navigated += 1),
    });

    const title = await screen.findByText("Double tap title");
    fireEvent.click(title);
    fireEvent.click(title);

    expect(
      screen.getByRole("textbox", { name: "Rename Double tap title" }),
    ).toBeDefined();
    await passDoubleClickWindow();
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
    );
    expect(navigated).toBe(0);
  });

  it("cancels an empty or escaped rename", async () => {
    configureFakeSdk({
      threads: [thread("thr_cancel_rename", { title: "Keep title" })],
    });
    renderList();

    const title = await screen.findByText("Keep title");
    fireEvent.click(title);
    fireEvent.click(title);
    const input = screen.getByRole("textbox", { name: "Rename Keep title" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    expect(sidebarActionCalls.some((call) => call.method === "rename")).toBe(
      false,
    );
    expect(await screen.findByText("Keep title")).toBeDefined();

    const keptTitle = screen.getByText("Keep title");
    fireEvent.click(keptTitle);
    fireEvent.click(keptTitle);
    const escapedInput = screen.getByRole("textbox", {
      name: "Rename Keep title",
    });
    fireEvent.change(escapedInput, { target: { value: "Discard me" } });
    fireEvent.keyDown(escapedInput, { key: "Escape" });
    expect(sidebarActionCalls.some((call) => call.method === "rename")).toBe(
      false,
    );
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

  it("adds a project and opens a new thread in it", async () => {
    configureFakeSdk({
      projectHosts: [
        { id: "host-primary", name: "Desktop" },
        { id: "host-other", name: "Laptop" },
      ],
      primaryHostId: "host-primary",
      createdProjectId: "project-created",
      projectDirectories: {
        "host-primary:<home>": {
          directory: "/work",
          parent: "/",
          entries: [
            { name: "new-project", path: "/work/new-project" },
          ],
        },
        "host-primary:/work/new-project": {
          directory: "/work/new-project",
          parent: "/work",
          entries: [],
        },
      },
    });
    let navigated = 0;
    const onNavigate = () => (navigated += 1);
    const rendered = renderList({ onNavigate });

    fireEvent.click(
      await screen.findByRole("button", { name: "Add project" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Add project" });
    await waitFor(() =>
      expect(rpcCalls).toContainEqual({
        method: "projectCreationContext",
        input: {},
      }),
    );
    expect(
      (within(dialog).getByLabelText("Machine") as HTMLSelectElement).value,
    ).toBe("host-primary");

    fireEvent.click(
      await within(dialog).findByRole("button", { name: "new-project" }),
    );
    await within(dialog).findByText("Project name:");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add project" }),
    );

    await waitFor(() =>
      expect(rpcCalls).toContainEqual({
        method: "addProject",
        input: { hostId: "host-primary", path: "/work/new-project" },
      }),
    );
    expect(sidebarActionCalls).toContainEqual({
      method: "openNewThread",
      options: { projectId: "project-created", focusPrompt: true },
    });
    expect(navigated).toBe(1);

    setFakeProjects([
      { id: "project-1", name: "bb", isPersonal: false },
      { id: "project-created", name: "new-project", isPersonal: false },
    ]);
    rendered.rerender(listElement({ onNavigate }));

    await waitFor(() =>
      expect(
        (screen.getByLabelText("Filter by project") as HTMLSelectElement)
          .value,
      ).toBe("project-created"),
    );
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
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
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
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
    );
  });
});

describe("BoardSidebar display-only pull requests", () => {
  it("auto-settles quiet work while keeping its open PR badge and link", async () => {
    const now = Date.now();
    configureFakeSdk({
      threads: [
        thread("quiet-open", {
          title: "Quiet with open PR",
          latestAttentionAt: now - 3 * DAY,
        }),
      ],
      pullRequests: {
        "quiet-open": {
          number: 81,
          title: "Still under review",
          url: "https://example.test/pulls/81",
          state: "open",
          attention: "ready_to_merge",
        },
      },
    });
    renderList();

    const settled = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(settled).getByRole("button"));
    expect(within(settled).getByText("Quiet with open PR")).toBeDefined();

    const badge = await within(settled).findByRole("link", {
      name: "Open pull request #81: Still under review",
    });
    expect(badge.getAttribute("href")).toBe("https://example.test/pulls/81");
  });

  it("keeps an explicit settle when a descendant has a draft PR", async () => {
    const now = Date.now();
    configureFakeSdk({
      threads: [
        thread("settled-root", { title: "Explicitly settled" }),
        thread("draft-child", {
          title: "Draft child",
          parentThreadId: "settled-root",
        }),
      ],
      overrides: [
        { threadId: "settled-root", override: "settled", at: now + DAY },
      ],
      pullRequests: {
        "draft-child": {
          number: 82,
          title: "Child work",
          url: "https://example.test/pulls/82",
          state: "draft",
          attention: "draft",
        },
      },
    });
    renderList();

    const settled = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(settled).getByRole("button"));
    fireEvent.click(within(settled).getByLabelText("Expand 1 subagents"));

    expect(within(settled).getByText("Draft child")).toBeDefined();
    const badge = await within(settled).findByRole("link", {
      name: "Draft pull request #82: Child work",
    });
    expect(badge.getAttribute("href")).toBe("https://example.test/pulls/82");
  });

  it("keeps recent merged and closed work in Inbox after probes report", async () => {
    const recent = Date.now() - HOUR;
    configureFakeSdk({
      threads: [
        thread("recent-merged", {
          title: "Recently merged",
          latestAttentionAt: recent,
        }),
        thread("recent-closed", {
          title: "Recently closed",
          latestAttentionAt: recent,
        }),
      ],
      pullRequests: {
        "recent-merged": {
          number: 83,
          title: "Merged work",
          url: "https://example.test/pulls/83",
          state: "merged",
          attention: "merged",
        },
        "recent-closed": {
          number: 84,
          title: "Closed work",
          url: "https://example.test/pulls/84",
          state: "closed",
          attention: "closed",
        },
      },
    });
    renderList();

    await act(async () => {});
    const inbox = await screen.findByRole("region", { name: "Inbox" });
    expect(within(inbox).getByText("Recently merged")).toBeDefined();
    expect(within(inbox).getByText("Recently closed")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
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

  // Opening the path is a courtesy, not a lock. Deriving it every render would
  // re-open the row the instant the user closed it.
  it("lets the user collapse an active thread's ancestor again", async () => {
    configureFakeSdk({ threads: tree() });
    renderList({ activeThreadId: "child" });

    await screen.findByText("Subagent");
    fireEvent.click(screen.getByLabelText("Collapse 1 subagents"));

    expect(screen.queryByText("Subagent")).toBeNull();
  });

  it("opens the path to a match that only a subagent satisfies", async () => {
    configureFakeSdk({ threads: tree() });
    renderList({ searchQuery: "subagent" });

    expect(await screen.findByText("Parent")).toBeDefined();
    expect(screen.getByText("Subagent")).toBeDefined();
  });

  // Same for the shelf: it opens itself for the active thread, and one click
  // still shuts it.
  it("lets the user collapse the shelf while a settled thread is active", async () => {
    configureFakeSdk({
      threads: [thread("thr_done", { title: "Finished work" })],
      overrides: [{ threadId: "thr_done", override: "settled", at: NOW + DAY }],
    });
    renderList({ activeThreadId: "thr_done" });

    const settled = await screen.findByRole("region", { name: "Settled" });
    expect(within(settled).getByText("Finished work")).toBeDefined();

    fireEvent.click(within(settled).getByRole("button", { expanded: true }));
    expect(within(settled).queryByText("Finished work")).toBeNull();
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

describe("pinned reordering", () => {
  const pins = () => [
    thread("a", { title: "First", isPinned: true }),
    thread("b", { title: "Second", isPinned: true }),
    thread("c", { title: "Third", isPinned: true }),
  ];

  function pinnedSidebar(props: Partial<PluginThreadListProps> = {}) {
    configureFakeSdk({ threads: pins(), pinnedOrder: ["a", "b", "c"] });
    return renderList(props);
  }

  function setPinnedRowRects() {
    const links = within(screen.getByRole("region", { name: "Pinned" }))
      .getAllByRole("link")
      .filter((link) => link.hasAttribute("data-sidebar-thread-id"));
    links.forEach((link, index) => {
      const row = link.closest("li")!;
      const top = index * 48;
      row.getBoundingClientRect = () =>
        ({
          x: 0,
          y: top,
          top,
          left: 0,
          right: 240,
          bottom: top + 48,
          width: 240,
          height: 48,
          toJSON: () => ({}),
        }) as DOMRect;
    });
  }

  async function dragToThird(label: HTMLElement) {
    setPinnedRowRects();
    const source = label.closest("li")!;
    fireEvent.mouseDown(label, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 72,
    });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 20, clientY: 78 });
    await waitFor(() =>
      expect(source.getAttribute("data-pinned-reordering")).toBe("true"),
    );
    fireEvent.mouseMove(document, { buttons: 1, clientX: 20, clientY: 132 });
    fireEvent.mouseUp(document, { button: 0, clientX: 20, clientY: 132 });
  }

  it.each([
    ["title", "Second"],
    ["project", "Project: bb"],
    ["machine", "Machine: Unknown machine"],
  ])(
    "starts pointer reorder from the %s label and keeps split attached",
    async (_kind, labelTitle) => {
      configureFakeSdk({
        threads: pins(),
        pinnedOrder: ["a", "b", "c"],
      });
      renderList();

      const anchor = await screen.findByRole("link", { name: "Second" });
      const row = anchor.parentElement!;
      await waitFor(() => expect(row.getAttribute("role")).toBe("button"));
      const label = within(row).getByTitle(labelTitle);

      fireEvent.pointerDown(label, { button: 0, clientX: 20, clientY: 72 });
      expect(splitPointerDownCalls).toContainEqual({
        threadId: "b",
        targetTitle: labelTitle,
        currentThreadId: "b",
      });

      await dragToThird(label);
      await waitFor(() =>
        expect(rpcCalls).toContainEqual({
          method: "movePinned",
          input: { threadId: "b", previousThreadId: "c", nextThreadId: null },
        }),
      );
    },
  );

  it("blocks a second reorder until BB returns the first canonical order", async () => {
    configureFakeSdk({
      threads: pins(),
      pinnedOrder: ["a", "b", "c"],
      deferRpc: ["movePinned"],
      pullRequests: {
        c: {
          number: 43,
          title: "Third change",
          url: "https://example.test/pulls/43",
          state: "open",
          attention: "ready_to_merge",
        },
      },
    });
    renderList();

    const second = await screen.findByRole("link", { name: "Second" });
    await waitFor(() =>
      expect(second.parentElement?.getAttribute("role")).toBe("button"),
    );
    await dragToThird(within(second.parentElement!).getByTitle("Second"));
    await waitFor(() =>
      expect(rpcCalls.filter((call) => call.method === "movePinned")).toHaveLength(
        1,
      ),
    );

    const third = screen.getByRole("link", { name: "Third" });
    const thirdLabel = within(third.parentElement!).getByTitle("Third");
    await waitFor(() =>
      expect(third.parentElement?.getAttribute("role")).toBeNull(),
    );
    expect(
      within(screen.getByRole("region", { name: "Pinned" }))
        .getAllByRole("link")
        .map((row) => row.getAttribute("data-sidebar-thread-id"))
        .filter((threadId) => threadId !== null),
    ).toEqual(["a", "c", "b"]);

    // The projected list is visible, but it must not feed a second move until
    // BB has made that order canonical.
    setPinnedRowRects();
    fireEvent.mouseDown(thirdLabel, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 72,
    });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 20, clientY: 78 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 20, clientY: 132 });
    fireEvent.mouseUp(document, { button: 0, clientX: 20, clientY: 132 });
    expect(rpcCalls.filter((call) => call.method === "movePinned")).toHaveLength(
      1,
    );

    fireEvent.pointerDown(thirdLabel, { button: 0, clientX: 20, clientY: 72 });
    expect(splitPointerDownCalls).toContainEqual({
      threadId: "c",
      targetTitle: "Third",
      currentThreadId: "c",
    });

    fireEvent.contextMenu(thirdLabel);
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).getByText("Mark unread")).toBeDefined();
    expect(within(menu).queryByText("Move up")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull(),
    );

    // Reorder click suppression is intentionally brief; the RPC gate itself
    // must leave ordinary row and PR clicks alone.
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    fireEvent.click(thirdLabel);
    const prLink = within(third.parentElement!).getByRole("link", {
      name: "Open pull request #43: Third change",
    });
    fireEvent.click(prLink);
    await passDoubleClickWindow();
    expect(
      sidebarActionCalls.filter((call) => call.method === "open"),
    ).toEqual([{ method: "open", threadId: "c", options: undefined }]);

    await act(async () =>
      resolvePendingRpc("movePinned", "oldest", { ids: ["a", "c", "b"] }),
    );
    await waitFor(() =>
      expect(third.parentElement?.getAttribute("role")).toBe("button"),
    );

    await dragToThird(thirdLabel);
    await waitFor(() =>
      expect(rpcCalls).toContainEqual({
        method: "movePinned",
        input: { threadId: "c", previousThreadId: "b", nextThreadId: null },
      }),
    );
    await act(async () =>
      resolvePendingRpc("movePinned", "oldest", { ids: ["a", "b", "c"] }),
    );
  });

  it("cancels an active reorder on Escape without moving", async () => {
    pinnedSidebar();

    const anchor = await screen.findByRole("link", { name: "Second" });
    const label = within(anchor.parentElement!).getByTitle("Second");
    setPinnedRowRects();
    const source = label.closest("li")!;

    fireEvent.mouseDown(label, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 72,
    });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 20, clientY: 78 });
    await waitFor(() =>
      expect(source.getAttribute("data-pinned-reordering")).toBe("true"),
    );
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(source.getAttribute("data-pinned-reordering")).toBeNull(),
    );
    fireEvent.mouseUp(document, { button: 0, clientX: 20, clientY: 132 });
    fireEvent.click(label);

    expect(rpcCalls.some((call) => call.method === "movePinned")).toBe(false);
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
    );
  });

  it("cancels a pending reorder on Escape before activation", async () => {
    pinnedSidebar();

    const anchor = await screen.findByRole("link", { name: "Second" });
    const label = within(anchor.parentElement!).getByTitle("Second");
    setPinnedRowRects();

    fireEvent.mouseDown(label, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 72,
    });
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 20, clientY: 132 });
    fireEvent.mouseUp(document, { button: 0, clientX: 20, clientY: 132 });

    expect(
      anchor.closest("li")?.getAttribute("data-pinned-reordering"),
    ).toBeNull();
    expect(rpcCalls.some((call) => call.method === "movePinned")).toBe(false);
  });

  it("keeps PR, expand, and settle controls out of both gestures", async () => {
    configureFakeSdk({
      threads: [
        ...pins(),
        thread("child", { title: "Child", parentThreadId: "b" }),
        thread("quiet", { title: "Quiet" }),
      ],
      pinnedOrder: ["a", "b", "c"],
      pullRequests: {
        b: {
          number: 42,
          title: "Pinned change",
          url: "https://example.test/pulls/42",
          state: "open",
          attention: "ready_to_merge",
        },
      },
    });
    renderList();

    const anchor = await screen.findByRole("link", { name: "Second" });
    const row = anchor.parentElement!;
    await waitFor(() => expect(row.getAttribute("role")).toBe("button"));
    setPinnedRowRects();
    const controls = [
      within(row).getByRole("link", {
        name: "Open pull request #42: Pinned change",
      }),
      within(row).getByRole("button", { name: "Expand 1 subagents" }),
      screen.getByRole("button", { name: "Settle" }),
    ];

    for (const control of controls) {
      fireEvent.pointerDown(control, { button: 0, clientX: 20, clientY: 72 });
      fireEvent.mouseDown(control, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 72,
      });
      fireEvent.mouseMove(document, { buttons: 1, clientX: 20, clientY: 90 });
      fireEvent.mouseUp(document, { button: 0, clientX: 20, clientY: 90 });
    }

    expect(splitPointerDownCalls).toEqual([]);
    expect(
      anchor.closest("li")?.getAttribute("data-pinned-reordering"),
    ).toBeNull();
    expect(rpcCalls.some((call) => call.method === "movePinned")).toBe(false);
  });

  it("keeps normal row opens and PR clicks independent", async () => {
    configureFakeSdk({
      threads: pins(),
      pinnedOrder: ["a", "b", "c"],
      pullRequests: {
        b: {
          number: 42,
          title: "Pinned change",
          url: "https://example.test/pulls/42",
          state: "open",
          attention: "ready_to_merge",
        },
      },
    });
    let navigated = 0;
    renderList({ onNavigate: () => (navigated += 1) });

    const anchor = await screen.findByRole("link", { name: "Second" });
    const row = anchor.parentElement!;
    const titleLabel = within(row).getByTitle("Second");

    fireEvent.click(titleLabel);
    await passDoubleClickWindow();
    expect(sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "b",
      options: undefined,
    });
    expect(navigated).toBe(1);

    const prLink = within(row).getByRole("link", {
      name: "Open pull request #42: Pinned change",
    });
    fireEvent.click(prLink);
    expect(
      sidebarActionCalls.filter((call) => call.method === "open"),
    ).toHaveLength(1);
    expect(navigated).toBe(1);
  });

  it("consumes only the drag-release click and allows the next real click", async () => {
    pinnedSidebar();

    const anchor = await screen.findByRole("link", { name: "Second" });
    const label = within(anchor.parentElement!).getByTitle("Second");
    await dragToThird(label);
    await waitFor(() =>
      expect(rpcCalls.some((call) => call.method === "movePinned")).toBe(true),
    );
    const movedAnchor = screen.getByRole("link", { name: "Second" });
    await waitFor(() =>
      expect(
        movedAnchor.closest("li")?.getAttribute("data-pinned-reordering"),
      ).toBeNull(),
    );
    const movedLabel = within(movedAnchor.parentElement!).getByTitle("Second");

    expect(fireEvent.click(movedLabel)).toBe(false);
    expect(
      sidebarActionCalls.some((call) => call.method === "open"),
    ).toBe(false);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    });
    expect(
      fireEvent.click(screen.getByRole("link", { name: "Second" })),
    ).toBe(false);
    expect(
      sidebarActionCalls.filter((call) => call.method === "open"),
    ).toEqual([{ method: "open", threadId: "b", options: undefined }]);
  });

  // No reorder sensor on a phone, which is why the context menu carries moves.
  it("does not attach reorder activators on a compact viewport", async () => {
    pinnedSidebar({ isCompactViewport: true });

    const anchor = await screen.findByRole("link", { name: "Second" });
    expect(anchor.parentElement?.getAttribute("role")).toBeNull();
  });

  // Browser href dragging must not steal either pointer gesture.
  it("keeps the row's open anchor undraggable", async () => {
    pinnedSidebar();

    const row = await screen.findByRole("link", { name: "Second" });
    expect(row.getAttribute("draggable")).toBe("false");
  });

  it("keeps reorder activators off until bb's order has loaded", async () => {
    configureFakeSdk({ threads: pins(), failPinnedOrder: true });
    renderList();

    const anchor = await screen.findByRole("link", { name: "Second" });
    expect(anchor.parentElement?.getAttribute("role")).toBeNull();
  });

  // The menu waits on the order too. Moving against a stale rank would file
  // the thread beside the wrong neighbour, silently.
  it("offers no menu moves until bb's order has loaded", async () => {
    configureFakeSdk({ threads: pins(), failPinnedOrder: true });
    renderList();

    fireEvent.contextMenu(await screen.findByText("Second"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).queryByText("Move up")).toBeNull();
    expect(within(menu).queryByText("Move down")).toBeNull();
  });

  // Pinning goes through the host, not our RPC, so nothing publishes on the
  // pinned-order channel. A newly pinned thread would otherwise sit at a rank
  // bb never gave it until something unrelated refreshed the board.
  it("re-reads the order when the set of pinned threads changes", async () => {
    configureFakeSdk({ threads: pins(), pinnedOrder: ["a", "b", "c"] });
    const rendered = renderList();
    await screen.findByText("First");

    setFakeThreads([...pins(), thread("d", { title: "Fourth", isPinned: true })]);
    // bb slots the new pin second — not where the unknown-id fallback puts it.
    setFakePinnedOrder(["a", "d", "b", "c"]);
    rendered.rerender(listElement());

    await waitFor(() =>
      expect(
        rpcCalls.filter((call) => call.method === "pinnedOrder"),
      ).toHaveLength(2),
    );
    await waitFor(() => {
      const pinned = screen.getByRole("region", { name: "Pinned" });
      expect(
        within(pinned)
          .getAllByRole("link")
          .map((row) => row.getAttribute("data-sidebar-thread-id")),
      ).toEqual(["a", "d", "b", "c"]);
    });
  });

  // The RPC boundary: whatever the menu computed must reach the server call
  // unchanged, because bb places the thread strictly between those two ids.
  it("sends the neighbouring ids through to movePinned", async () => {
    pinnedSidebar();

    fireEvent.contextMenu(await screen.findByText("Third"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Move up"));

    await waitFor(() =>
      expect(rpcCalls).toContainEqual({
        method: "movePinned",
        input: { threadId: "c", previousThreadId: "a", nextThreadId: "b" },
      }),
    );
  });

  it("offers no move past either end of the list", async () => {
    pinnedSidebar();

    fireEvent.contextMenu(await screen.findByText("First"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).getByText("Move up").getAttribute("data-disabled")).not
      .toBeNull();
    expect(
      within(menu).getByText("Move down").getAttribute("data-disabled"),
    ).toBeNull();
  });

  // A rejected move must not leave a guessed order on screen: the board
  // re-reads and shows whatever bb actually has.
  it("re-reads the order when a move is rejected", async () => {
    configureFakeSdk({
      threads: pins(),
      pinnedOrder: ["a", "b", "c"],
      failMovePinned: true,
    });
    renderList();

    fireEvent.contextMenu(await screen.findByText("Third"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    // bb's real order turns out to be something else entirely.
    setFakePinnedOrder(["c", "b", "a"]);
    fireEvent.click(within(menu).getByText("Move up"));

    await waitFor(() =>
      expect(
        rpcCalls.filter((call) => call.method === "pinnedOrder"),
      ).toHaveLength(2),
    );
    await waitFor(() => {
      const pinned = screen.getByRole("region", { name: "Pinned" });
      expect(
        within(pinned)
          .getAllByRole("link")
          .map((row) => row.getAttribute("data-sidebar-thread-id")),
      ).toEqual(["c", "b", "a"]);
    });
  });

  it("renders pinned rows in bb's order", async () => {
    configureFakeSdk({ threads: pins(), pinnedOrder: ["c", "a", "b"] });
    renderList();

    const pinned = await screen.findByRole("region", { name: "Pinned" });
    await waitFor(() =>
      expect(
        within(pinned)
          .getAllByRole("link")
          .map((row) => row.getAttribute("data-sidebar-thread-id")),
      ).toEqual(["c", "a", "b"]),
    );
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
    ).toEqual(["Mark unread", "Pin", "Rename", "Archive", "Delete"]);
  });

  it("starts inline rename from the thread menu", async () => {
    configureFakeSdk({
      threads: [thread("thr_menu_rename", { title: "Menu rename" })],
    });
    renderList();

    fireEvent.contextMenu(await screen.findByText("Menu rename"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Rename"));

    expect(
      await screen.findByRole("textbox", { name: "Rename Menu rename" }),
    ).toBeDefined();
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
    expect(sidebarActionCalls.some((call) => call.method === "open")).toBe(
      false,
    );
  });
});

describe("Bots section", () => {
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
        { id: "project-1", name: "bb", isPersonal: false },
        { id: "assist-1", name: "assistants", isPersonal: false },
      ],
      assistantOrder,
    });
    return renderList();
  }

  it("shows assistants under Bots in the stored order, never in Inbox", async () => {
    fleetSidebar(["env-hands", "env-sam"]);

    const bots = await screen.findByRole("region", { name: "Bots" });
    const rows = Array.from(bots.querySelectorAll("[data-sidebar-thread-id]"));
    expect(rows.map((row) => row.getAttribute("data-sidebar-thread-id"))).toEqual(
      ["thr_hands", "thr_sam"],
    );

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
});

describe("Bots preview cap", () => {
  const crowd = () =>
    ["one", "two", "three", "four"].map((name) =>
      thread(`thr_${name}`, {
        title: name,
        projectId: "assist-1",
        environment: { id: `env-${name}` } as BoardThread["environment"],
      }),
    );

  function crowdedSidebar(props: Partial<PluginThreadListProps> = {}) {
    configureFakeSdk({
      threads: crowd(),
      projects: [
        { id: "project-1", name: "bb", isPersonal: false },
        { id: "assist-1", name: "assistants", isPersonal: false },
      ],
      assistantOrder: ["env-one", "env-two", "env-three", "env-four"],
    });
    return renderList(props);
  }

  const botIds = (bots: HTMLElement) =>
    Array.from(bots.querySelectorAll("[data-sidebar-thread-id]")).map((row) =>
      row.getAttribute("data-sidebar-thread-id"),
    );

  it("shows three bots until Show more, and Show less re-caps", async () => {
    crowdedSidebar();
    const bots = await screen.findByRole("region", { name: "Bots" });
    expect(botIds(bots)).toEqual(["thr_one", "thr_two", "thr_three"]);

    fireEvent.click(within(bots).getByRole("button", { name: "Show more" }));
    expect(botIds(bots)).toEqual([
      "thr_one",
      "thr_two",
      "thr_three",
      "thr_four",
    ]);

    fireEvent.click(within(bots).getByRole("button", { name: "Show less" }));
    expect(botIds(bots)).toEqual(["thr_one", "thr_two", "thr_three"]);
  });

  it("lets a search reach a bot the cap hides", async () => {
    crowdedSidebar({ searchQuery: "four" });
    const bots = await screen.findByRole("region", { name: "Bots" });
    expect(botIds(bots)).toEqual(["thr_four"]);
    expect(
      within(bots).queryByRole("button", { name: "Show more" }),
    ).toBeNull();
  });
});
