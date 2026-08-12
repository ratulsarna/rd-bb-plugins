import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBbContext,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import {
  catalogCacheKey,
  favoriteAvailabilityError,
  nextPickerState,
} from "@/lib/favorites";
import type {
  Catalog,
  Favorite,
  FavoriteSeed,
  PickerHost,
  PickerProject,
  ReasoningLevel,
  ServiceTier,
} from "@/lib/schema";
import type { rpcContract } from "../server";
import { ComposeOverlay } from "./compose-overlay";
import { FavoritePicker } from "./favorite-picker";
import { FavoriteTile } from "./favorite-tile";

interface PickerState {
  name: string;
  projectId: string;
  hostId: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | "";
  serviceTier: ServiceTier | "";
}

interface ComposeSession {
  seed: FavoriteSeed;
  sessionKey: string;
}

const emptyPicker: PickerState = {
  name: "",
  projectId: "",
  hostId: "",
  providerId: "",
  model: "",
  reasoningLevel: "",
  serviceTier: "",
};

export function FavoritesPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId: routeProjectId } = useBbContext();
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [projects, setProjects] = useState<PickerProject[]>([]);
  const [hosts, setHosts] = useState<PickerHost[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogKey, setCatalogKey] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [picker, setPicker] = useState<PickerState>(emptyPicker);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeSession | null>(null);
  const openRequestId = useRef(0);

  const loadFavorites = useCallback(async () => {
    const result = await rpc.call("listFavorites", {});
    setFavorites(result.favorites);
  }, [rpc]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      rpc.call("listFavorites", {}),
      rpc.call("pickerOptions", {}),
    ])
      .then(([favoriteResult, optionResult]) => {
        if (cancelled) return;
        setFavorites(favoriteResult.favorites);
        setProjects(optionResult.projects);
        setHosts(optionResult.hosts);
        setPicker((current) =>
          nextPickerState({
            ...current,
            projectId: current.projectId || routeProjectId || "",
            projects: optionResult.projects,
            hosts: optionResult.hosts,
            catalog: null,
          }),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Could not load favorites.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routeProjectId, rpc]);

  useRealtime("favorites", () => {
    void loadFavorites().catch((cause: unknown) => {
      setError(
        cause instanceof Error ? cause.message : "Could not refresh favorites.",
      );
    });
  });

  useEffect(() => {
    if (
      previousConnection.current === "reconnecting" &&
      connection === "connected"
    ) {
      void loadFavorites().catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not refresh favorites.",
        );
      });
    }
    previousConnection.current = connection;
  }, [connection, loadFavorites]);

  const requestedCatalogKey = picker.hostId
    ? catalogCacheKey(picker.hostId, picker.providerId)
    : "";
  const catalogReady =
    Boolean(catalog) && catalogKey === requestedCatalogKey && !catalogLoading;

  useEffect(() => {
    if (!picker.hostId) {
      setCatalog(null);
      setCatalogKey("");
      setCatalogLoading(false);
      return;
    }

    const requested = catalogCacheKey(picker.hostId, picker.providerId);
    let cancelled = false;
    setCatalogLoading(true);
    rpc
      .call("catalog", {
        hostId: picker.hostId,
        ...(picker.providerId ? { providerId: picker.providerId } : {}),
      })
      .then((next) => {
        if (cancelled) return;
        setCatalog(next);
        setCatalogKey(requested);
        setPicker((current) =>
          nextPickerState({
            ...current,
            projects,
            hosts,
            catalog: next,
          }),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setCatalog({
            providers: [],
            models: [],
            error:
              cause instanceof Error
                ? cause.message
                : "Could not load catalog.",
          });
          setCatalogKey(requested);
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hosts, picker.hostId, picker.providerId, projects, rpc]);

  async function saveFavorite() {
    if (
      !catalogReady ||
      !picker.projectId ||
      !picker.hostId ||
      !picker.providerId ||
      !picker.model ||
      !picker.reasoningLevel
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await rpc.call("createFavorite", {
        name: picker.name,
        projectId: picker.projectId,
        hostId: picker.hostId,
        providerId: picker.providerId,
        model: picker.model,
        reasoningLevel: picker.reasoningLevel,
        serviceTier: picker.serviceTier || null,
      });
      setPicker((current) => ({ ...current, name: "" }));
      await loadFavorites();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save favorite.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteFavorite(id: string) {
    setError(null);
    try {
      await rpc.call("deleteFavorite", { id });
      setFavorites((current) =>
        current.filter((favorite) => favorite.id !== id),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not delete favorite.",
      );
    }
  }

  async function openFavorite(favorite: Favorite) {
    const requestId = ++openRequestId.current;
    const availabilityError = favoriteAvailabilityError(favorite);
    if (availabilityError) {
      if (requestId === openRequestId.current) setError(availabilityError);
      return;
    }
    if (requestId === openRequestId.current) setError(null);
    try {
      const result = await rpc.call("seedFavorite", { id: favorite.id });
      if (requestId !== openRequestId.current) return;
      setCompose({
        seed: result.seed,
        sessionKey: `${favorite.id}:${Date.now()}`,
      });
    } catch (cause) {
      if (requestId !== openRequestId.current) return;
      setError(
        cause instanceof Error ? cause.message : "Could not open favorite.",
      );
    }
  }

  const liveCatalog = catalogReady ? catalog : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <section className="min-h-0 flex-1 overflow-auto p-5">
        {loading ? (
          <p className="text-[13px] text-muted-foreground">
            Loading favorites…
          </p>
        ) : favorites.length === 0 ? (
          <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
            No favorites yet. Pick a project, machine, harness, model, and
            reasoning below, then save.
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
            {favorites.map((favorite) => (
              <FavoriteTile
                key={favorite.id}
                favorite={favorite}
                onOpen={() => void openFavorite(favorite)}
                onDelete={() => void deleteFavorite(favorite.id)}
              />
            ))}
          </div>
        )}
      </section>
      <FavoritePicker
        projects={projects}
        hosts={hosts}
        catalog={liveCatalog}
        catalogLoading={catalogLoading || Boolean(requestedCatalogKey && !catalogReady)}
        name={picker.name}
        projectId={picker.projectId}
        hostId={picker.hostId}
        providerId={picker.providerId}
        model={picker.model}
        reasoningLevel={picker.reasoningLevel}
        serviceTier={picker.serviceTier}
        saving={saving}
        error={error}
        onName={(name) => setPicker((current) => ({ ...current, name }))}
        onProjectId={(projectId) =>
          setPicker((current) =>
            nextPickerState({
              ...current,
              projectId,
              projects,
              hosts,
              catalog: liveCatalog,
            }),
          )
        }
        onHostId={(hostId) =>
          setPicker((current) =>
            nextPickerState({
              ...current,
              hostId,
              projects,
              hosts,
              catalog: null,
            }),
          )
        }
        onProviderId={(providerId) =>
          setPicker((current) => ({
            ...current,
            providerId,
            model: "",
            reasoningLevel: "",
            serviceTier: "",
          }))
        }
        onModel={(model) =>
          setPicker((current) =>
            nextPickerState({
              ...current,
              model,
              projects,
              hosts,
              catalog: liveCatalog,
            }),
          )
        }
        onReasoningLevel={(reasoningLevel) =>
          setPicker((current) => ({ ...current, reasoningLevel }))
        }
        onServiceTier={(serviceTier) =>
          setPicker((current) => ({ ...current, serviceTier }))
        }
        onSave={() => void saveFavorite()}
      />
      {compose ? (
        <ComposeOverlay
          seed={compose.seed}
          sessionKey={compose.sessionKey}
          onClose={() => setCompose(null)}
        />
      ) : null}
    </div>
  );
}
