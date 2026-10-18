import { describe, expect, it } from "vitest";
import { serverApi, type ServerApiOptions } from "./server-fake";

// The fleet the tests know: one project, a source registered per machine.
const PROJECT = { id: "proj_fleet", name: "assistants", sources: [
  { hostId: "host_vps", path: "/home/me/assistants" },
  { hostId: "host_mac", path: "/Users/me/assistants" },
] };
const VAULT = { id: "proj_vault", name: "ObsidianVault", sources: [
  { hostId: "host_vps", path: "/home/me/ObsidianVault" },
  { hostId: "host_mac", path: "/Users/me/Vault/ObsidianVault" },
] };

const env = (id: string, hostId: string, path: string | null) => ({
  id,
  projectId: PROJECT.id,
  hostId,
  path,
});

const thread = (id: string, environmentId: string) => ({
  id,
  title: "Sam",
  environmentId,
  projectId: PROJECT.id,
});

const fleet = (extra: Partial<ServerApiOptions> = {}): ServerApiOptions => ({
  projects: [PROJECT, VAULT],
  privateSyncStatus: {
    enabled: false, paused: false, configError: null,
    folders: [
      { id: "assistants", nodes: PROJECT.sources.map((source) => ({ ...source, ready: false, phase: "disabled", error: null })) },
      { id: "vault", nodes: VAULT.sources.map((source) => ({ ...source, ready: false, phase: "disabled", error: null })) },
    ],
  },
  machineDirectory: PROJECT.sources.map((source) => ({ hostId: source.hostId, name: source.hostId, connected: true })),
  ...extra,
});

describe("assistantIdentities", () => {
  it("resolves the same home to one identity on every machine", async () => {
    const h = serverApi(
      fleet({
        environments: {
          env_vps: env("env_vps", "host_vps", "/home/me/assistants/sam"),
          env_mac: env(
            "env_mac",
            "host_mac",
            "/Users/me/assistants/sam",
          ),
        },
      }),
    );
    expect(
      await h.handlers.assistantIdentities({
        environmentIds: ["env_vps", "env_mac"],
      } as never),
    ).toEqual({
      rows: [
        { environmentId: "env_vps", identity: "proj_fleet:sam" },
        { environmentId: "env_mac", identity: "proj_fleet:sam" },
      ],
    });
  });

  it("falls back to the environment id when nothing is derivable", async () => {
    const h = serverApi(
      fleet({
        environments: {
          env_root: env("env_root", "host_vps", "/home/me/assistants"),
          env_deep: env(
            "env_deep",
            "host_vps",
            "/home/me/assistants/sam/memory",
          ),
          env_elsewhere: env(
            "env_elsewhere",
            "host_vps",
            "/home/me/other/sam",
          ),
        },
      }),
    );
    const { rows } = (await h.handlers.assistantIdentities({
      environmentIds: [
        "env_root",
        "env_deep",
        "env_elsewhere",
        "env_unknown",
      ],
    } as never)) as { rows: Array<{ environmentId: string; identity: string }> };
    expect(rows).toEqual([
      { environmentId: "env_root", identity: "env_root" },
      { environmentId: "env_deep", identity: "env_deep" },
      { environmentId: "env_elsewhere", identity: "env_elsewhere" },
      { environmentId: "env_unknown", identity: "env_unknown" },
    ]);
  });
});

describe("subtitle store", () => {
  it("refuses a thread without an environment", async () => {
    const h = serverApi(
      fleet({ threads: { thr_bare: { id: "thr_bare", environmentId: null } } }),
    );
    await expect(
      h.handlers.setAssistantSubtitle({
        threadId: "thr_bare",
        subtitle: "x",
      } as never),
    ).rejects.toThrow(/no environment/);
  });
});

describe("assistantSeeds", () => {
  it("carries the identity and the vault path registered on the host", async () => {
    const h = serverApi(
      fleet({
        environments: {
          env_sam: env("env_sam", "host_mac", "/Users/me/assistants/sam"),
        },
        threads: { thr_sam: thread("thr_sam", "env_sam") },
      }),
    );
    const seeds = (await h.handlers.assistantSeeds({
      threadId: "thr_sam",
    } as never)) as Record<string, unknown>;
    expect(seeds.identity).toBe("proj_fleet:sam");
    expect(seeds.vaultPath).toBe("/Users/me/Vault/ObsidianVault");
  });

  it("gives no vault path when Private Sync has no destination vault mapping", async () => {
    const h = serverApi(
      fleet({
        privateSyncStatus: {
          enabled: false, paused: false, configError: null,
          folders: [{ id: "assistants", nodes: PROJECT.sources.map((source) => ({ ...source, ready: false, phase: "disabled", error: null })) }],
        },
        environments: {
          env_sam: env("env_sam", "host_mac", "/Users/me/assistants/sam"),
        },
        threads: { thr_sam: thread("thr_sam", "env_sam") },
      }),
    );
    const seeds = (await h.handlers.assistantSeeds({
      threadId: "thr_sam",
    } as never)) as Record<string, unknown>;
    expect(seeds.identity).toBe("proj_fleet:sam");
    expect(seeds.vaultPath).toBeNull();
  });
});

describe("assistant order", () => {
  it("stores the identities a drag sends, deduplicated", async () => {
    const h = serverApi(fleet({}));
    const result = (await h.handlers.setAssistantOrder({
      identities: ["proj_fleet:sam", "proj_fleet:forge", "proj_fleet:sam"],
    } as never)) as { ids: string[] };
    const stored = (await h.handlers.assistantOrder({} as never)) as {
      ids: string[];
    };
    expect(result.ids).toEqual(["proj_fleet:sam", "proj_fleet:forge"]);
    expect(stored.ids).toEqual(["proj_fleet:sam", "proj_fleet:forge"]);
  });
});
