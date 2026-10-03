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

const LEGACY_SCHEMA = [
  `CREATE TABLE assistant_subtitles (
     environment_id TEXT PRIMARY KEY,
     subtitle TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE TABLE assistant_order (
     environment_id TEXT PRIMARY KEY,
     rank INTEGER NOT NULL
   )`,
];

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

describe("assistant key migration", () => {
  it("rewrites legacy environment keys, keeping every subtitle and rank", async () => {
    const h = serverApi({
      ...fleet({
        environments: {
          env_sam: env("env_sam", "host_vps", "/home/me/assistants/sam"),
          // A mishomed environment resolves fine but has no identity.
          env_hands: env("env_hands", "host_vps", "/home/me/assistants"),
        },
      }),
      preMigrate: LEGACY_SCHEMA,
    });
    h.db.prepare(
      `INSERT INTO assistant_subtitles VALUES ('env_sam', 'Chief of staff', 100)`,
    ).run();
    h.db.prepare(
      `INSERT INTO assistant_order VALUES ('env_sam', 0), ('env_hands', 1)`,
    ).run();
    await h.flush();

    expect(await h.handlers.listAssistantSubtitles({} as never)).toEqual({
      rows: [{ identity: "proj_fleet:sam", subtitle: "Chief of staff" }],
    });
    // The environment with no stable identity keeps its own id rather than
    // dropping the row.
    expect(await h.handlers.assistantOrder({} as never)).toEqual({
      ids: ["proj_fleet:sam", "env_hands"],
    });
  });

  it("keeps the newest subtitle when two old environments map to one identity", async () => {
    const h = serverApi({
      ...fleet({
        environments: {
          env_old: env("env_old", "host_vps", "/home/me/assistants/sam"),
          env_new: env("env_new", "host_vps", "/home/me/assistants/sam/"),
        },
      }),
      preMigrate: LEGACY_SCHEMA,
    });
    h.db.prepare(
      `INSERT INTO assistant_subtitles VALUES ('env_old', 'stale', 100)`,
    ).run();
    h.db.prepare(
      `INSERT INTO assistant_subtitles VALUES ('env_new', 'current', 200)`,
    ).run();
    await h.flush();

    expect(await h.handlers.listAssistantSubtitles({} as never)).toEqual({
      rows: [{ identity: "proj_fleet:sam", subtitle: "current" }],
    });
  });

  it("defers the whole rewrite when a lookup fails, and retries on restart", async () => {
    // bb answers the environment but the project lookup fails — a transient
    // error, not an environment without an identity.
    const h = serverApi({
      projects: [],
      environments: {
        env_sam: env("env_sam", "host_vps", "/home/me/assistants/sam"),
      },
      preMigrate: LEGACY_SCHEMA,
    });
    h.db.prepare(
      `INSERT INTO assistant_subtitles VALUES ('env_sam', 'Chief of staff', 100)`,
    ).run();
    h.db.prepare(`INSERT INTO assistant_order VALUES ('env_sam', 0)`).run();
    await h.flush();

    // Nothing was rewritten, and no flag row marks the pass done.
    expect(h.db.prepare(`SELECT * FROM assistant_subtitles`).all()).toEqual([
      { identity: "env_sam", subtitle: "Chief of staff", at: 100 },
    ]);
    expect(h.db.prepare(`SELECT * FROM assistant_key_migration`).all()).toEqual(
      [],
    );
    expect(h.warnings.join("\n")).toContain("deferred");

    // The error clears, bb restarts, and the legacy data comes across whole.
    h.restart({ projects: [PROJECT, VAULT] });
    await h.flush();
    expect(await h.handlers.listAssistantSubtitles({} as never)).toEqual({
      rows: [{ identity: "proj_fleet:sam", subtitle: "Chief of staff" }],
    });
    expect(await h.handlers.assistantOrder({} as never)).toEqual({
      ids: ["proj_fleet:sam"],
    });
    expect(h.db.prepare(`SELECT * FROM assistant_key_migration`).all()).toEqual([
      { done: 1 },
    ]);
  });

  it("runs once; a restart does not touch the migrated rows", async () => {
    const h = serverApi({
      ...fleet({
        environments: {
          env_sam: env("env_sam", "host_vps", "/home/me/assistants/sam"),
          // A mishomed environment resolves fine but has no identity.
          env_lost: env("env_lost", "host_vps", "/home/me/assistants"),
        },
      }),
      preMigrate: LEGACY_SCHEMA,
    });
    h.db.prepare(
      `INSERT INTO assistant_subtitles VALUES ('env_sam', 'Chief of staff', 100)`,
    ).run();
    await h.flush();
    h.db.prepare(
      `INSERT INTO assistant_subtitles VALUES ('env_lost', 'unsourced', 200)`,
    ).run();

    h.restart();
    await h.flush();
    // The flag row short-circuits the pass: the identity-less key the first
    // pass kept is left exactly as it was.
    expect(await h.handlers.listAssistantSubtitles({} as never)).toEqual({
      rows: [
        { identity: "proj_fleet:sam", subtitle: "Chief of staff" },
        { identity: "env_lost", subtitle: "unsourced" },
      ],
    });
  });

  it("keeps a source-less key safe, then migrates it once the source lands", async () => {
    // Cutover reality: the WSL source is registered only after the plugin
    // has already run once with the legacy tables in place.
    const vpsOnly = { id: "proj_fleet", name: "assistants", sources: [
      { hostId: "host_vps", path: "/home/me/assistants" },
    ] };
    const withWsl = { id: "proj_fleet", name: "assistants", sources: [
      ...vpsOnly.sources,
      { hostId: "host_wsl", path: "/home/me/assistants" },
    ] };
    const environments = {
      env_sam: env("env_sam", "host_vps", "/home/me/assistants/sam"),
      env_wsl: env("env_wsl", "host_wsl", "/home/me/assistants/sam"),
    };
    const h = serverApi({
      projects: [vpsOnly, VAULT],
      environments,
      preMigrate: LEGACY_SCHEMA,
    });
    h.db.prepare(
      `INSERT INTO assistant_subtitles VALUES ('env_sam', 'Chief of staff', 100)`,
    ).run();
    h.db.prepare(
      `INSERT INTO assistant_subtitles VALUES ('env_wsl', 'On the road', 200)`,
    ).run();
    h.db.prepare(
      `INSERT INTO assistant_order VALUES ('env_sam', 0), ('env_wsl', 1)`,
    ).run();
    await h.flush();

    // The resolvable key moved; the source-less one kept its data untouched
    // and the pass did NOT declare itself done.
    expect(await h.handlers.listAssistantSubtitles({} as never)).toEqual({
      rows: [
        { identity: "proj_fleet:sam", subtitle: "Chief of staff" },
        { identity: "env_wsl", subtitle: "On the road" },
      ],
    });
    expect(h.db.prepare(`SELECT * FROM assistant_key_migration`).all()).toEqual(
      [],
    );

    // The source arrives; the next start finishes the job. Both old keys map
    // to one identity, and the newest subtitle wins, as always.
    h.restart({ projects: [withWsl, VAULT] });
    await h.flush();
    expect(await h.handlers.listAssistantSubtitles({} as never)).toEqual({
      rows: [{ identity: "proj_fleet:sam", subtitle: "On the road" }],
    });
    expect(((await h.handlers.assistantOrder({} as never)) as { ids: string[] }).ids).toEqual([
      "proj_fleet:sam",
    ]);
    expect(h.db.prepare(`SELECT * FROM assistant_key_migration`).all()).toEqual([
      { done: 1 },
    ]);
  });

  it("does not clobber a drag that lands while the pass awaits lookups", async () => {
    let release!: () => void;
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const environments: Record<string, Record<string, unknown>> = {
      env_sam: env("env_sam", "host_vps", "/home/me/assistants/sam"),
      // A mishomed environment resolves fine but has no identity.
      env_hands: env("env_hands", "host_vps", "/home/me/assistants"),
    };
    const h = serverApi({
      projects: [PROJECT, VAULT],
      threads: {
        thr_sam: thread("thr_sam", "env_sam"),
        thr_hands: thread("thr_hands", "env_hands"),
      },
      environmentsGet: async (environmentId: string) => {
        await gated;
        return environments[environmentId];
      },
      preMigrate: LEGACY_SCHEMA,
    });
    h.db.prepare(
      `INSERT INTO assistant_subtitles VALUES ('env_sam', 'legacy', 100)`,
    ).run();
    h.db.prepare(
      `INSERT INTO assistant_order VALUES ('env_sam', 0), ('env_hands', 1)`,
    ).run();

    // The pass is parked inside the gated lookup. Meanwhile the user reorders
    // and edits a subtitle — acknowledged writes the snapshot never saw.
    const drag = h.handlers.setAssistantOrder({
      identities: ["proj_fleet:hands", "proj_fleet:sam"],
    } as never);
    const edit = h.handlers.setAssistantSubtitle({
      threadId: "thr_sam",
      subtitle: "newer",
    } as never);
    release();
    await drag;
    await edit;
    await h.flush();

    // The drag's order survived, and the newer subtitle beat the legacy one.
    expect(((await h.handlers.assistantOrder({} as never)) as { ids: string[] }).ids).toEqual([
      "proj_fleet:hands",
      "proj_fleet:sam",
    ]);
    expect(await h.handlers.listAssistantSubtitles({} as never)).toEqual({
      rows: [{ identity: "proj_fleet:sam", subtitle: "newer" }],
    });
    expect(h.db.prepare(`SELECT * FROM assistant_key_migration`).all()).toEqual([
      { done: 1 },
    ]);
  });

  it("publishes on both channels after rewriting", async () => {
    const h = serverApi({
      ...fleet({ environments: {} }),
      preMigrate: LEGACY_SCHEMA,
    });
    await h.flush();
    const channels = h.publishes.map((publish) => publish.channel);
    expect(channels).toContain("assistant-subtitles");
    expect(channels).toContain("assistant-order");
  });
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
    await h.flush();
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
    await h.flush();
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
  const samThread = {
    ...fleet({
      environments: {
        env_sam: env("env_sam", "host_vps", "/home/me/assistants/sam"),
      },
      threads: { thr_sam: thread("thr_sam", "env_sam") },
    }),
  };

  it("stores by identity, so a reattached thread finds its subtitle", async () => {
    const h = serverApi(samThread);
    await h.flush();
    await h.handlers.setAssistantSubtitle({
      threadId: "thr_sam",
      subtitle: "Chief of staff",
    } as never);
    expect(await h.handlers.listAssistantSubtitles({} as never)).toEqual({
      rows: [{ identity: "proj_fleet:sam", subtitle: "Chief of staff" }],
    });

    // Empty clears.
    await h.handlers.setAssistantSubtitle({
      threadId: "thr_sam",
      subtitle: "",
    } as never);
    expect(await h.handlers.listAssistantSubtitles({} as never)).toEqual({
      rows: [],
    });
  });

  it("refuses a thread without an environment", async () => {
    const h = serverApi(
      fleet({ threads: { thr_bare: { id: "thr_bare", environmentId: null } } }),
    );
    await h.flush();
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
    await h.flush();
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
    await h.flush();
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
    await h.flush();
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
