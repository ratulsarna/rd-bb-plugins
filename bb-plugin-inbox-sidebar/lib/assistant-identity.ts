/**
 * Stable assistant identity. An assistant is a home directory below the
 * fleet root, and the fleet lives in one BB project with a registered source
 * per machine — so the identity that survives a machine switch is the
 * project id plus the home's path relative to the source registered on the
 * thread's own host: `<projectId>:sam`.
 *
 * Environment ids cannot serve here: reattaching a thread to the same home
 * on another machine mints a new environment, and everything keyed by
 * environment id would disappear. Identities are derived on the server, from
 * the environment plus the project's sources.
 */

/** The BB project the assistant fleet lives in. */
export const ASSISTANTS_PROJECT_NAME = "assistants";

/** The project rendered by Bots; other name matches stay on the board. */
export function selectedAssistantsProjectId(
  projects: readonly { id: string; name: string }[],
): string | null {
  return projects.find(
    (project) => project.name.toLowerCase() === ASSISTANTS_PROJECT_NAME,
  )?.id ?? null;
}

/** The home directory segment that is Sam, in every host's fleet root. */
export const SAM_HOME_SEGMENT = "sam";

export interface AssistantSource {
  hostId: string;
  path: string;
}

export interface AssistantEnvironmentFacts {
  projectId: string;
  hostId: string;
  path: string | null;
}

/**
 * The one path segment directly below `root`, or null. Homes sit directly
 * below the fleet root, so anything else — the root itself (a mishomed
 * thread), a nested path, an unrelated tree that merely starts with the same
 * characters — is not a home.
 */
export function homeSegmentUnder(path: string, root: string): string | null {
  const base = root.replace(/\/+$/, "");
  const full = path.replace(/\/+$/, "");
  if (base === "" || !full.startsWith(`${base}/`)) return null;
  const rest = full.slice(base.length + 1);
  return rest === "" || rest.includes("/") ? null : rest;
}

/**
 * `<projectId>:<home>` for an environment that sits directly below a source
 * of its own project registered on the environment's host; null otherwise.
 * A null identity is "no stable assistant": the caller falls back to the
 * environment id instead of inventing one.
 */
export function assistantIdentity(
  env: AssistantEnvironmentFacts,
  sources: readonly AssistantSource[],
): string | null {
  const source = sources.find((candidate) => candidate.hostId === env.hostId);
  const segment =
    env.path && source ? homeSegmentUnder(env.path, source.path) : null;
  return segment === null ? null : `${env.projectId}:${segment}`;
}

export interface ResolvedIdentity {
  /** False when the lookup itself failed — not an answer, a retry. */
  ok: boolean;
  /** Set iff the environment sits in a home of its project. */
  identity: string | null;
  /** True when a registered source on this host is all that's missing. */
  awaitingSource: boolean;
}

/** The slice of the plugin API identity lookups read. */
interface IdentityLookups {
  sdk: {
    environments: { get(args: { environmentId: string }): Promise<{ projectId: string; hostId: string; path: string | null }> };
    projects: { get(args: { projectId: string }): Promise<{ sources: AssistantSource[] }> };
  };
  log: { warn(message: string): void };
}

/**
 * The server's lookup of an environment's assistant identity. Identity comes
 * from the environment plus its project's registered sources, and sources
 * change when a machine is added — so the cache lives for a minute, not
 * forever. Environment facts themselves are stable.
 */
export function createIdentityResolver(
  bb: IdentityLookups,
): (environmentId: string) => Promise<ResolvedIdentity> {
  const IDENTITY_TTL_MS = 60_000;
  const identityCache = new Map<
    string,
    { at: number; resolved: ResolvedIdentity }
  >();
  return async (environmentId) => {
    const cached = identityCache.get(environmentId);
    if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) {
      return cached.resolved;
    }
    let resolved: ResolvedIdentity = { ok: false, identity: null, awaitingSource: false };
    try {
      const env = await bb.sdk.environments.get({ environmentId });
      let sources: AssistantSource[];
      try {
        sources = (await bb.sdk.projects.get({ projectId: env.projectId })).sources;
      } catch (error) {
        // A project lookup hiccup is transient; retry, keeping the key.
        bb.log.warn(
          `assistant identity for ${environmentId} unresolved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return resolved;
      }
      resolved = {
        ok: true,
        identity: assistantIdentity(env, sources),
        awaitingSource: !sources.some((candidate) => candidate.hostId === env.hostId),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) {
        // The environment is gone for good: an answer, not a failure. Its
        // rows keep their key.
        resolved = { ok: true, identity: null, awaitingSource: false };
      } else {
        bb.log.warn(`assistant identity for ${environmentId} unresolved: ${message}`);
      }
    }
    if (resolved.ok && !resolved.awaitingSource) {
      identityCache.set(environmentId, { at: Date.now(), resolved });
    }
    return resolved;
  };
}
