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
