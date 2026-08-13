import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  catalogCacheKey,
  favoriteLaunchError,
  favoriteSaveError,
  favoriteSeedFromConfig,
  findModel,
  findProvider,
  mergeCatalogModels,
  newFavoriteId,
  normalizeFavoriteName,
} from "./lib/favorites";
import { spawnFromComposerRequest } from "./lib/create-thread";
import {
  catalogSchema,
  favoriteInputSchema,
  favoriteSchema,
  favoriteSeedSchema,
  type Favorite,
  type PickerHost,
  type PickerModel,
  type PickerProject,
  type PickerProvider,
} from "./lib/schema";

const FAVORITES_CHANNEL = "favorites";

interface FavoriteRow {
  id: string;
  name: string;
  project_id: string;
  host_id: string;
  provider_id: string;
  model: string;
  reasoning_level: string;
  service_tier: string | null;
  created_at: number;
}

export const rpcContract = defineRpcContract({
  listFavorites: {
    input: z.object({}).strict(),
    output: z.object({ favorites: z.array(favoriteSchema) }).strict(),
  },
  pickerOptions: {
    input: z.object({}).strict(),
    output: z
      .object({
        projects: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              kind: z.enum(["personal", "standard"]),
              hostIds: z.array(z.string()),
            })
            .strict(),
        ),
        hosts: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              status: z.enum(["connected", "disconnected"]),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  catalog: {
    input: z
      .object({
        hostId: z.string().trim().min(1),
        providerId: z.string().trim().min(1).optional(),
      })
      .strict(),
    output: catalogSchema,
  },
  createFavorite: {
    input: favoriteInputSchema,
    output: z.object({ favorite: favoriteSchema }).strict(),
  },
  deleteFavorite: {
    input: z.object({ id: z.string().trim().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  seedFavorite: {
    input: z.object({ id: z.string().trim().min(1) }).strict(),
    output: z.object({ seed: favoriteSeedSchema }).strict(),
  },
  createThread: {
    input: z.object({ request: z.unknown() }).strict(),
    output: z.object({ threadId: z.string() }).strict(),
  },
});

function asFavoriteRow(row: unknown): FavoriteRow | undefined {
  return row as FavoriteRow | undefined;
}

async function loadProjects(bb: BbPluginApi): Promise<PickerProject[]> {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    kind: project.kind,
    hostIds: project.sources.map((source) => source.hostId),
  }));
}

async function loadHosts(bb: BbPluginApi): Promise<PickerHost[]> {
  const hosts = await bb.sdk.hosts.list();
  return hosts.map((host) => ({
    id: host.id,
    name: host.name,
    status: host.status,
  }));
}

function mapProviders(
  providers: Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["list"]>>,
): PickerProvider[] {
  return providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    available: provider.available,
    supportsServiceTier: provider.capabilities.supportsServiceTier,
  }));
}

function mapModels(
  models: Awaited<
    ReturnType<BbPluginApi["sdk"]["providers"]["models"]>
  >["models"],
): PickerModel[] {
  return models.map((model) => ({
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    isDefault: model.isDefault,
  }));
}

function hydrateFavorite(
  row: FavoriteRow,
  projects: readonly PickerProject[],
  hosts: readonly PickerHost[],
  catalog: {
    providers: readonly PickerProvider[];
    models: readonly PickerModel[];
  } | null,
): Favorite {
  const project = projects.find((entry) => entry.id === row.project_id);
  const host = hosts.find((entry) => entry.id === row.host_id);
  const provider = catalog?.providers.find(
    (entry) => entry.id === row.provider_id,
  );
  const model = catalog?.models.find(
    (entry) => entry.model === row.model || entry.id === row.model,
  );

  return {
    id: row.id,
    name: normalizeFavoriteName(row.name),
    projectId: row.project_id,
    projectName:
      project?.kind === "personal"
        ? "No project"
        : (project?.name ?? "Missing project"),
    projectKind: project?.kind ?? "standard",
    projectMissing: !project,
    hostId: row.host_id,
    hostName: host?.name ?? "Missing machine",
    hostStatus: host?.status ?? "missing",
    providerId: row.provider_id,
    providerName: provider?.displayName ?? row.provider_id,
    model: row.model,
    modelName: model?.displayName ?? row.model,
    reasoningLevel: row.reasoning_level as Favorite["reasoningLevel"],
    serviceTier: (row.service_tier ?? null) as Favorite["serviceTier"],
    createdAt: row.created_at,
  };
}

async function loadCatalog(
  bb: BbPluginApi,
  hostId: string,
  providerId?: string,
): Promise<{
  providers: PickerProvider[];
  models: PickerModel[];
  error: string | null;
}> {
  try {
    const [providers, options] = await Promise.all([
      bb.sdk.providers.list({ hostId }),
      bb.sdk.providers.models({
        hostId,
        ...(providerId ? { providerId } : {}),
      }),
    ]);
    return {
      providers: mapProviders(providers),
      models: mergeCatalogModels(
        mapModels(options.models),
        mapModels(options.selectedOnlyModels),
      ),
      error: options.modelLoadError
        ? `Could not load models for ${options.modelLoadError.providerId}.`
        : null,
    };
  } catch (error) {
    return {
      providers: [],
      models: [],
      error: error instanceof Error ? error.message : "Could not load catalog.",
    };
  }
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS favorites (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       host_id TEXT NOT NULL,
       provider_id TEXT NOT NULL,
       model TEXT NOT NULL,
       reasoning_level TEXT NOT NULL,
       service_tier TEXT,
       created_at INTEGER NOT NULL
     )`,
    `ALTER TABLE favorites ADD COLUMN name TEXT NOT NULL DEFAULT ''`,
  ]);

  const selectAll = db.prepare(
    `SELECT id, name, project_id, host_id, provider_id, model, reasoning_level, service_tier, created_at
     FROM favorites
     ORDER BY created_at DESC`,
  );
  const selectOne = db.prepare(
    `SELECT id, name, project_id, host_id, provider_id, model, reasoning_level, service_tier, created_at
     FROM favorites
     WHERE id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO favorites (
       id, name, project_id, host_id, provider_id, model, reasoning_level, service_tier, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const remove = db.prepare(`DELETE FROM favorites WHERE id = ?`);

  bb.rpc.register(rpcContract, {
    async listFavorites() {
      const [projects, hosts] = await Promise.all([
        loadProjects(bb),
        loadHosts(bb),
      ]);
      const rows = selectAll.all().map((row) => asFavoriteRow(row)!);
      const catalogs = new Map<
        string,
        Promise<{
          providers: PickerProvider[];
          models: PickerModel[];
          error: string | null;
        }>
      >();

      const favorites = await Promise.all(
        rows.map(async (row) => {
          const key = catalogCacheKey(row.host_id, row.provider_id);
          let pending = catalogs.get(key);
          if (!pending) {
            pending = loadCatalog(bb, row.host_id, row.provider_id);
            catalogs.set(key, pending);
          }
          return hydrateFavorite(row, projects, hosts, await pending);
        }),
      );

      return { favorites };
    },

    async pickerOptions() {
      const [projects, hosts] = await Promise.all([
        loadProjects(bb),
        loadHosts(bb),
      ]);
      return { projects, hosts };
    },

    async catalog({ hostId, providerId }) {
      return loadCatalog(bb, hostId, providerId);
    },

    async createFavorite(input) {
      const [projects, hosts] = await Promise.all([
        loadProjects(bb),
        loadHosts(bb),
      ]);
      const project = projects.find((entry) => entry.id === input.projectId);
      if (!project) throw new Error("That project is no longer available.");
      const host = hosts.find((entry) => entry.id === input.hostId);
      if (!host) throw new Error("That machine is no longer available.");
      if (host.status !== "connected") {
        throw new Error(`${host.name} is disconnected.`);
      }
      if (
        project.kind !== "personal" &&
        !project.hostIds.includes(input.hostId)
      ) {
        throw new Error(`${project.name} has no checkout on ${host.name}.`);
      }

      const catalog = await loadCatalog(bb, input.hostId, input.providerId);
      const provider = findProvider(catalog.providers, input.providerId);
      const model = findModel(catalog.models, input.model);
      const saveError = favoriteSaveError({
        project,
        host,
        provider,
        model,
        reasoningLevel: input.reasoningLevel,
        serviceTier: input.serviceTier,
        catalogError: catalog.error,
      });
      if (saveError) throw new Error(saveError);
      if (!provider || !model) throw new Error("Invalid favorite.");

      const name = normalizeFavoriteName(input.name);
      const favorite: Favorite = {
        id: newFavoriteId(),
        name,
        projectId: project.id,
        projectName: project.name,
        projectKind: project.kind,
        projectMissing: false,
        hostId: host.id,
        hostName: host.name,
        hostStatus: host.status,
        providerId: provider.id,
        providerName: provider.displayName,
        model: model.model,
        modelName: model.displayName,
        reasoningLevel: input.reasoningLevel,
        serviceTier: provider.supportsServiceTier ? input.serviceTier : null,
        createdAt: Date.now(),
      };

      insert.run(
        favorite.id,
        favorite.name,
        favorite.projectId,
        favorite.hostId,
        favorite.providerId,
        favorite.model,
        favorite.reasoningLevel,
        favorite.serviceTier,
        favorite.createdAt,
      );
      bb.realtime.publish(FAVORITES_CHANNEL, { id: favorite.id });
      return { favorite };
    },

    async deleteFavorite({ id }) {
      const existing = asFavoriteRow(selectOne.get(id));
      if (!existing) throw new Error("That favorite is gone.");
      remove.run(id);
      bb.realtime.publish(FAVORITES_CHANNEL, { id });
      return { ok: true as const };
    },

    async seedFavorite({ id }) {
      const row = asFavoriteRow(selectOne.get(id));
      if (!row) throw new Error("That favorite is gone.");
      const [projects, hosts, catalog] = await Promise.all([
        loadProjects(bb),
        loadHosts(bb),
        loadCatalog(bb, row.host_id, row.provider_id),
      ]);
      const favorite = hydrateFavorite(row, projects, hosts, catalog);
      const project = projects.find((entry) => entry.id === favorite.projectId) ?? null;
      const host = hosts.find((entry) => entry.id === favorite.hostId) ?? null;
      const provider = findProvider(catalog.providers, favorite.providerId);
      const model = findModel(catalog.models, favorite.model);
      const launchError = favoriteLaunchError({
        project,
        host,
        provider,
        model,
        reasoningLevel: favorite.reasoningLevel,
        serviceTier: favorite.serviceTier,
        catalogError: catalog.error,
      });
      if (launchError) throw new Error(launchError);
      if (!project || !host || !provider || !model) {
        throw new Error("That favorite is no longer valid.");
      }
      return {
        seed: favoriteSeedFromConfig({
          projectId: project.id,
          projectKind: project.kind,
          hostId: host.id,
          providerId: provider.id,
          model: model.model,
          reasoningLevel: favorite.reasoningLevel,
          serviceTier: favorite.serviceTier,
        }),
      };
    },

    async createThread({ request }) {
      return spawnFromComposerRequest(
        (args) =>
          bb.sdk.threads.spawn(
            args as Parameters<typeof bb.sdk.threads.spawn>[0],
          ),
        request,
      );
    },
  });
}
