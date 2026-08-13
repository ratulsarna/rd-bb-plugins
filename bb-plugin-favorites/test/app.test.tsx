// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../app";
import type { Catalog, Favorite, PickerHost, PickerProject } from "@/lib/schema";
import {
  composerDrafts,
  configureFakeSdk,
  emitRealtime,
  lastComposerProps,
  navigateCalls,
  registrations,
  rpcCalls,
  setRealtimeConnectionState,
} from "./sdk-fake";

const panel = registrations.navPanels[0]!;
const Panel = panel.component;

const projects: PickerProject[] = [
  {
    id: "proj_plugins",
    name: "plugins",
    kind: "standard",
    hostIds: ["host_mac"],
  },
  {
    id: "proj_personal",
    name: "Personal",
    kind: "personal",
    hostIds: [],
  },
];

const hosts: PickerHost[] = [
  { id: "host_mac", name: "MacBook Pro 16", status: "connected" },
];

const catalog: Catalog = {
  providers: [
    {
      id: "codex",
      displayName: "Codex",
      available: true,
      supportsServiceTier: true,
    },
    {
      id: "claude-code",
      displayName: "Claude Code",
      available: true,
      supportsServiceTier: false,
    },
  ],
  models: [
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "low" },
        { reasoningEffort: "medium", description: "medium" },
        { reasoningEffort: "high", description: "high" },
        { reasoningEffort: "xhigh", description: "xhigh" },
      ],
      defaultReasoningEffort: "low",
      isDefault: true,
    },
  ],
  error: null,
};

const favorite: Favorite = {
  id: "fav_1",
  name: "",
  projectId: "proj_plugins",
  projectName: "plugins",
  projectKind: "standard",
  projectMissing: false,
  hostId: "host_mac",
  hostName: "MacBook Pro 16",
  hostStatus: "connected",
  providerId: "codex",
  providerName: "Codex",
  model: "gpt-5.6-sol",
  modelName: "GPT-5.6-Sol",
  reasoningLevel: "xhigh",
  serviceTier: "fast",
  createdAt: 1,
};

function handlerState(initial: Favorite[] = [favorite]) {
  const favorites = [...initial];
  return (method: string, input: unknown) => {
    if (method === "listFavorites") return { favorites: [...favorites] };
    if (method === "pickerOptions") return { projects, hosts };
    if (method === "catalog") return catalog;
    if (method === "createFavorite") {
      const projectId = (input as { projectId: string }).projectId;
      const selectedProject = projects.find((entry) => entry.id === projectId)!;
      const created = {
        ...favorite,
        id: "fav_new",
        name: "",
        ...(input as object),
        projectName:
          selectedProject.kind === "personal"
            ? "No project"
            : selectedProject.name,
        projectKind: selectedProject.kind,
        projectMissing: false,
        hostName: "MacBook Pro 16",
        hostStatus: "connected" as const,
        providerName: "Codex",
        modelName: "GPT-5.6-Sol",
        createdAt: 2,
      };
      favorites.unshift(created);
      return { favorite: created };
    }
    if (method === "deleteFavorite") {
      const id = (input as { id: string }).id;
      const index = favorites.findIndex((entry) => entry.id === id);
      if (index >= 0) favorites.splice(index, 1);
      return { ok: true };
    }
    if (method === "seedFavorite") {
      const id = (input as { id: string }).id;
      const selected = favorites.find((entry) => entry.id === id) ?? favorite;
      return {
        seed: {
          projectId: selected.projectId,
          projectKind: selected.projectKind,
          hostId: selected.hostId,
          providerId: selected.providerId,
          model: selected.model,
          reasoningLevel: selected.reasoningLevel,
          serviceTier: selected.serviceTier ?? undefined,
        },
      };
    }
    if (method === "createThread") return { threadId: "thr_new" };
    throw new Error(`unexpected ${method}`);
  };
}

function renderPanel() {
  return render(<Panel subPath="" />);
}

afterEach(() => {
  cleanup();
});

describe("favorites registration", () => {
  it("registers a sidebar page named Favorites", () => {
    expect(panel.id).toBe("favorites");
    expect(panel.title).toBe("Favorites");
    expect(panel.path).toBe("favorites");
    expect(panel.icon).toBe("Star");
  });
});

describe("favorites panel", () => {
  it("shows labeled tiles and seeds compose without creating a thread", async () => {
    configureFakeSdk({ handler: handlerState() });
    renderPanel();

    const tile = await screen.findByRole("button", {
      name: "Open plugins Codex GPT-5.6-Sol",
    });
    expect(tile.textContent).toContain("Project");
    expect(tile.textContent).toContain("plugins");
    expect(tile.textContent).toContain("MacBook Pro 16");
    expect(tile.textContent).toContain("Codex");
    expect(tile.textContent).toContain("GPT-5.6-Sol");
    expect(tile.textContent).toContain("xhigh");
    expect(tile.textContent).toContain("Fast");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open plugins Codex GPT-5.6-Sol",
      }),
    );
    expect(await screen.findByTestId("new-thread-composer")).toBeTruthy();
    expect(screen.getByText("project:proj_plugins")).toBeTruthy();
    expect(screen.getByText("provider:codex")).toBeTruthy();
    expect(screen.getByText("model:gpt-5.6-sol")).toBeTruthy();
    expect(screen.getByText("reasoning:xhigh")).toBeTruthy();
    expect(screen.getByText("speed:fast")).toBeTruthy();
    expect(screen.getByText(/"hostId":"host_mac"/)).toBeTruthy();
    expect(lastComposerProps.draftKey?.startsWith("favorites:")).toBe(true);
    expect(lastComposerProps.layout).toBe("contained");
    expect(lastComposerProps.focusRequest).toBe(1);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );
    expect(rpcCalls.some((call) => call.method === "createThread")).toBe(false);
    expect(navigateCalls).toEqual([]);
  });

  it("creates a thread only after the seeded composer submits", async () => {
    configureFakeSdk({ handler: handlerState() });
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open plugins Codex GPT-5.6-Sol",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => {
      expect(rpcCalls.some((call) => call.method === "createThread")).toBe(true);
    });
    const create = rpcCalls.find((call) => call.method === "createThread");
    expect(create?.input).toMatchObject({
      request: {
        projectId: "proj_plugins",
        providerId: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
        serviceTier: "fast",
        executionInputSources: {
          providerId: "explicit",
          model: "explicit",
          reasoningLevel: "explicit",
          serviceTier: "explicit",
        },
      },
    });
    expect(navigateCalls).toEqual([{ kind: "thread", threadId: "thr_new" }]);
  });

  it("opens a later favorite on a fresh empty draft",
    async () => {
      configureFakeSdk({ handler: handlerState() });
      renderPanel();
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Open plugins Codex GPT-5.6-Sol",
        }),
      );
      expect(await screen.findByTestId("new-thread-composer")).toBeTruthy();
      const firstKey = lastComposerProps.draftKey;
      expect(firstKey).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Prompt"), {
        target: { value: "old prompt" },
      });
      expect(composerDrafts.get(firstKey!)).toBe("old prompt");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      fireEvent.click(
        screen.getByRole("button", {
          name: "Open plugins Codex GPT-5.6-Sol",
        }),
      );
      expect(await screen.findByTestId("new-thread-composer")).toBeTruthy();
      expect(lastComposerProps.draftKey).not.toBe(firstKey);
      expect(
        (screen.getByLabelText("Prompt") as HTMLTextAreaElement).value,
      ).toBe("");
    });

  it("saves the current picker selection as a new tile", async () => {
    configureFakeSdk({ handler: handlerState([]) });
    renderPanel();

    await screen.findByLabelText("Project");
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Model") as HTMLSelectElement).disabled,
      ).toBe(false);
    });
    fireEvent.change(screen.getByLabelText("Reasoning"), {
      target: { value: "xhigh" },
    });
    fireEvent.change(screen.getByLabelText("Speed"), {
      target: { value: "fast" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.method === "createFavorite")).toBe(
        true,
      );
    });
    expect(
      await screen.findByRole("button", {
        name: "Open plugins Codex GPT-5.6-Sol",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Open plugins Codex GPT-5.6-Sol",
      }).textContent,
    ).not.toContain("Sol deep");
  });

  it("saves and opens a favorite without a project", async () => {
    configureFakeSdk({ handler: handlerState([]) });
    renderPanel();

    const projectSelect = await screen.findByLabelText("Project");
    expect(screen.getByText("Don't work in a project")).toBeTruthy();
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Model") as HTMLSelectElement).disabled,
      ).toBe(false);
    });
    fireEvent.change(projectSelect, { target: { value: "proj_personal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        rpcCalls.find((call) => call.method === "createFavorite")?.input,
      ).toMatchObject({ projectId: "proj_personal" });
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open No project Codex GPT-5.6-Sol",
      }),
    );

    expect(await screen.findByTestId("new-thread-composer")).toBeTruthy();
    expect(screen.getByText("project:proj_personal")).toBeTruthy();
    expect(screen.getByText(/"workspace":\{"type":"personal"\}/)).toBeTruthy();
  });

  it("shows a typed name on the tile and leaves blank names empty", async () => {
    configureFakeSdk({ handler: handlerState([]) });
    renderPanel();
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Model") as HTMLSelectElement).disabled,
      ).toBe(false);
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Sol deep" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByRole("button", { name: "Open Sol deep" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Sol deep" }).textContent).toContain(
      "Sol deep",
    );
    expect(
      rpcCalls.find((call) => call.method === "createFavorite")?.input,
    ).toMatchObject({ name: "Sol deep" });
  });

  it("disables speed for Claude Code", async () => {
    configureFakeSdk({ handler: handlerState([]) });
    renderPanel();
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Harness") as HTMLSelectElement).disabled,
      ).toBe(false);
    });
    fireEvent.change(screen.getByLabelText("Harness"), {
      target: { value: "claude-code" },
    });
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Speed") as HTMLSelectElement).disabled,
      ).toBe(true);
    });
  });

  it("refreshes tiles after a realtime signal", async () => {
    let favorites = [favorite];
    configureFakeSdk({
      handler: (method) => {
        if (method === "listFavorites") return { favorites };
        if (method === "pickerOptions") return { projects, hosts };
        if (method === "catalog") return catalog;
        throw new Error(method);
      },
    });
    renderPanel();
    expect(await screen.findByText("GPT-5.6-Sol")).toBeTruthy();

    favorites = [
      {
        ...favorite,
        id: "fav_2",
        modelName: "GPT-5.6-Luna",
        model: "gpt-5.6-luna",
      },
    ];
    await act(async () => {
      emitRealtime("favorites");
    });
    expect(await screen.findByText("GPT-5.6-Luna")).toBeTruthy();
  });

  it("refetches favorites after a realtime reconnect",
    async () => {
      let favorites = [favorite];
      configureFakeSdk({
        connection: "reconnecting",
        handler: (method) => {
          if (method === "listFavorites") return { favorites };
          if (method === "pickerOptions") return { projects, hosts };
          if (method === "catalog") return catalog;
          throw new Error(method);
        },
      });
      renderPanel();
      expect(await screen.findByText("GPT-5.6-Sol")).toBeTruthy();
      const before = rpcCalls.filter((call) => call.method === "listFavorites")
        .length;
      favorites = [
        {
          ...favorite,
          id: "fav_3",
          modelName: "GPT-5.4-Mini",
          model: "gpt-5.4-mini",
        },
      ];
      await act(async () => {
        setRealtimeConnectionState("connected");
      });
      await waitFor(() => {
        expect(
          rpcCalls.filter((call) => call.method === "listFavorites").length,
        ).toBeGreaterThan(before);
      });
      expect(await screen.findByText("GPT-5.4-Mini")).toBeTruthy();
    });

  it("keeps the later tile when two seed requests finish out of order", async () => {
    let resolveFirst!: (value: { seed: typeof favoriteSeed }) => void;
    const favoriteSeed = {
      projectId: favorite.projectId,
      projectKind: favorite.projectKind,
      hostId: favorite.hostId,
      providerId: favorite.providerId,
      model: favorite.model,
      reasoningLevel: favorite.reasoningLevel,
      serviceTier: favorite.serviceTier ?? undefined,
    };
    const firstPromise = new Promise<{ seed: typeof favoriteSeed }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondFavorite: Favorite = {
      ...favorite,
      id: "fav_2",
      model: "gpt-5.6-luna",
      modelName: "GPT-5.6-Luna",
      reasoningLevel: "medium",
    };
    let seedCalls = 0;
    configureFakeSdk({
      handler: (method, input) => {
        if (method === "listFavorites") {
          return { favorites: [favorite, secondFavorite] };
        }
        if (method === "pickerOptions") return { projects, hosts };
        if (method === "catalog") return catalog;
        if (method === "seedFavorite") {
          seedCalls += 1;
          if ((input as { id: string }).id === "fav_1") return firstPromise;
          return {
            seed: {
              projectId: secondFavorite.projectId,
              projectKind: secondFavorite.projectKind,
              hostId: secondFavorite.hostId,
              providerId: secondFavorite.providerId,
              model: secondFavorite.model,
              reasoningLevel: secondFavorite.reasoningLevel,
              serviceTier: secondFavorite.serviceTier ?? undefined,
            },
          };
        }
        throw new Error(method);
      },
    });
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open plugins Codex GPT-5.6-Sol",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open plugins Codex GPT-5.6-Luna",
      }),
    );
    expect(await screen.findByText("model:gpt-5.6-luna")).toBeTruthy();
    await act(async () => {
      resolveFirst({ seed: favoriteSeed });
      await firstPromise;
    });
    expect(screen.getByText("model:gpt-5.6-luna")).toBeTruthy();
    expect(screen.queryByText("model:gpt-5.6-sol")).toBeNull();
    expect(seedCalls).toBe(2);
  });

  it("disables save when catalog discovery failed", async () => {
    configureFakeSdk({
      handler: (method) => {
        if (method === "listFavorites") return { favorites: [] };
        if (method === "pickerOptions") return { projects, hosts };
        if (method === "catalog") {
          return { ...catalog, error: "Could not load models for codex." };
        }
        throw new Error(method);
      },
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("Could not load models for codex.")).toBeTruthy();
    });
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
