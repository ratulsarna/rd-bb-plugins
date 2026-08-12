import { describe, expect, it } from "vitest";
import {
  environmentForFavorite,
  favoriteAvailabilityError,
  favoriteLaunchError,
  favoriteOpenLabel,
  favoriteSaveError,
  favoriteSeedFromConfig,
  mergeCatalogModels,
  nextPickerState,
  normalizeFavoriteName,
  projectHasHost,
  reconcileReasoning,
  reconcileServiceTier,
  speedLabel,
} from "./favorites";
import type {
  Catalog,
  Favorite,
  PickerHost,
  PickerModel,
  PickerProject,
  PickerProvider,
} from "./schema";

const project: PickerProject = {
  id: "proj_plugins",
  name: "plugins",
  kind: "standard",
  hostIds: ["host_mac"],
};

const personal: PickerProject = {
  id: "proj_personal",
  name: "personal",
  kind: "personal",
  hostIds: [],
};

const mac: PickerHost = {
  id: "host_mac",
  name: "MacBook Pro 16",
  status: "connected",
};

const server: PickerHost = {
  id: "host_srv",
  name: "Build server",
  status: "connected",
};

const offline: PickerHost = {
  id: "host_off",
  name: "offline-box",
  status: "disconnected",
};

const codex: PickerProvider = {
  id: "codex",
  displayName: "Codex",
  available: true,
  supportsServiceTier: true,
};

const claude: PickerProvider = {
  id: "claude-code",
  displayName: "Claude Code",
  available: true,
  supportsServiceTier: false,
};

const sol: PickerModel = {
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
};

const luna: PickerModel = {
  id: "gpt-5.6-luna",
  model: "gpt-5.6-luna",
  displayName: "GPT-5.6-Luna",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "low" },
    { reasoningEffort: "medium", description: "medium" },
    { reasoningEffort: "high", description: "high" },
  ],
  defaultReasoningEffort: "medium",
  isDefault: false,
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

describe("favorite names", () => {
  it("stores blank names as empty instead of inventing one", () => {
    expect(normalizeFavoriteName("   ")).toBe("");
    expect(normalizeFavoriteName("Sol deep")).toBe("Sol deep");
    expect(favoriteOpenLabel(favorite)).toBe("Open plugins Codex GPT-5.6-Sol");
    expect(favoriteOpenLabel({ ...favorite, name: "Sol deep" })).toBe(
      "Open Sol deep",
    );
  });
});

describe("favorite validation", () => {
  it("requires a checkout on the chosen machine", () => {
    expect(projectHasHost(project, "host_mac")).toBe(true);
    expect(projectHasHost(project, "host_srv")).toBe(false);
    expect(projectHasHost(personal, "host_srv")).toBe(true);
    expect(
      favoriteSaveError({
        project,
        host: server,
        provider: codex,
        model: sol,
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    ).toBe("plugins has no checkout on Build server.");
    expect(
      favoriteLaunchError({
        project,
        host: server,
        provider: codex,
        model: sol,
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    ).toBe("plugins has no checkout on Build server.");
  });

  it("hides speed for harnesses without tiers", () => {
    expect(reconcileServiceTier(claude, "fast")).toBeNull();
    expect(reconcileServiceTier(codex, null)).toBe("default");
    expect(speedLabel("fast")).toBe("Fast");
    expect(speedLabel("default")).toBe("Standard");
    expect(
      favoriteLaunchError({
        project,
        host: mac,
        provider: claude,
        model: sol,
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    ).toBe("Claude Code has no speed tiers.");
  });

  it("rejects unsupported reasoning instead of silently falling back", () => {
    expect(reconcileReasoning(luna, "ultra")).toBe("medium");
    expect(
      favoriteLaunchError({
        project,
        host: mac,
        provider: codex,
        model: luna,
        reasoningLevel: "xhigh",
        serviceTier: "fast",
      }),
    ).toBe("GPT-5.6-Luna does not support xhigh.");
  });

  it("keeps a selected-only model valid for launch and picker data", () => {
    const merged = mergeCatalogModels([sol], [luna]);
    expect(merged.map((entry) => entry.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-luna",
    ]);
    expect(
      favoriteLaunchError({
        project,
        host: mac,
        provider: codex,
        model: luna,
        reasoningLevel: "medium",
        serviceTier: "fast",
      }),
    ).toBeNull();
    expect(mergeCatalogModels([sol], [sol])).toHaveLength(1);
  });

  it("surfaces catalog discovery errors instead of pretending the favorite is gone", () => {
    expect(
      favoriteLaunchError({
        project,
        host: mac,
        provider: null,
        model: null,
        reasoningLevel: "xhigh",
        serviceTier: "fast",
        catalogError: "Could not load models for codex.",
      }),
    ).toBe("Could not load models for codex.");
  });

  it("blocks launching a missing project or disconnected machine", () => {
    expect(favoriteAvailabilityError(favorite)).toBeNull();
    expect(
      favoriteAvailabilityError({ ...favorite, hostStatus: "disconnected" }),
    ).toBe("MacBook Pro 16 is disconnected.");
    expect(
      favoriteAvailabilityError({ ...favorite, projectMissing: true }),
    ).toBe("plugins is no longer available.");
  });
});

describe("favorite seed", () => {
  it("maps a standard project onto that machine's unmanaged checkout", () => {
    expect(
      environmentForFavorite({
        projectKind: "standard",
        hostId: "host_mac",
      }),
    ).toEqual({
      type: "host",
      hostId: "host_mac",
      workspace: { type: "unmanaged", path: null },
    });
  });

  it("maps a personal project onto the personal workspace on that machine", () => {
    expect(
      environmentForFavorite({
        projectKind: "personal",
        hostId: "host_srv",
      }),
    ).toEqual({
      type: "host",
      hostId: "host_srv",
      workspace: { type: "personal" },
    });
  });

  it("omits speed from the seed when the harness has none", () => {
    expect(
      favoriteSeedFromConfig({
        projectId: "proj_plugins",
        projectKind: "standard",
        hostId: "host_mac",
        providerId: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
        serviceTier: null,
      }),
    ).toEqual({
      projectId: "proj_plugins",
      projectKind: "standard",
      hostId: "host_mac",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "xhigh",
    });
  });
});

describe("picker cascade", () => {
  const catalog: Catalog = {
    providers: [codex, claude],
    models: [sol, luna],
    error: null,
  };

  it("keeps a valid selection and resets an illegal machine for the project", () => {
    const next = nextPickerState({
      projects: [project],
      hosts: [mac, server, offline],
      catalog,
      projectId: "proj_plugins",
      hostId: "host_srv",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "xhigh",
      serviceTier: "fast",
    });
    expect(next.hostId).toBe("host_mac");
    expect(next.reasoningLevel).toBe("xhigh");
    expect(next.serviceTier).toBe("fast");
  });

  it("drops speed when switching to a harness without tiers", () => {
    const next = nextPickerState({
      projects: [project],
      hosts: [mac],
      catalog,
      projectId: "proj_plugins",
      hostId: "host_mac",
      providerId: "claude-code",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
    expect(next.serviceTier).toBe("");
  });

  it("does not invent harness or model values while the catalog is loading", () => {
    const next = nextPickerState({
      projects: [project],
      hosts: [mac],
      catalog: null,
      projectId: "proj_plugins",
      hostId: "host_mac",
      providerId: "codex",
      model: "",
      reasoningLevel: "",
      serviceTier: "",
    });
    expect(next.providerId).toBe("codex");
    expect(next.model).toBe("");
    expect(next.reasoningLevel).toBe("");
  });
});
