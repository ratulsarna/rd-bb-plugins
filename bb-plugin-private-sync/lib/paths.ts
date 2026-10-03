import { posix } from "node:path";

/**
 * Names never mirrored at any depth: version control, dependency trees, tool
 * caches, and per-machine credentials or local settings.
 */
export const DEFAULT_IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".DS_Store",
  "Thumbs.db",
  ".env",
  ".mcp.json",
  ".credentials.json",
  "settings.local.json",
  ".wispr",
  ".firecrawl",
]);

/** Machine-local runtime children of a directory whose other contents are portable. */
const IGNORED_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  ".claude": new Set(["projects", "cache", "todos", "history"]),
};

/** Prefix of the plugin's own in-flight temporary files inside a root. */
export const TEMP_PREFIX = ".bb-private-sync-";

/** A root-relative POSIX path with no empty, `.` or `..` segment. */
export function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.length > 4096) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0"))
    return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** An absolute POSIX directory path in normal form, other than `/`. */
export function isNormalAbsolutePath(path: string): boolean {
  return (
    path.length > 1 &&
    path.length <= 4096 &&
    !path.includes("\0") &&
    posix.isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path.endsWith("/")
  );
}

/** True when `path` is `prefix` or lies under it. Both are relative or both absolute. */
export function isWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Whether a root-relative path is excluded from mirroring. */
export function isIgnored(
  path: string,
  ignorePaths: readonly string[],
): boolean {
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    if (
      DEFAULT_IGNORED_NAMES.has(segment) ||
      segment.startsWith(".env.") ||
      segment.startsWith(TEMP_PREFIX) ||
      IGNORED_CHILDREN[segments[index - 1] ?? ""]?.has(segment)
    )
      return true;
  }
  return ignorePaths.some((ignored) => isWithin(path, ignored));
}

/**
 * A symlink is mirrored only when its target is relative and stays inside the
 * root lexically, so no node ever gains a link that leaves its folder.
 */
export function isSafeSymlinkTarget(linkPath: string, target: string): boolean {
  if (target === "" || target.includes("\0") || posix.isAbsolute(target))
    return false;
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
  return resolved !== ".." && !resolved.startsWith("../");
}

/** `notes/a.md` → `notes/a.sync-conflict-20261003-012233-host1.md`. */
export function conflictPath(
  path: string,
  hostId: string,
  at: Date,
  attempt = 0,
): string {
  const dir = posix.dirname(path);
  const name = posix.basename(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const host = hostId.replace(/[^A-Za-z0-9_-]/g, "").slice(-12) || "node";
  const suffix = attempt === 0 ? "" : `-${attempt}`;
  const file = `${stem}.sync-conflict-${stamp}-${host}${suffix}${ext}`;
  return dir === "." ? file : `${dir}/${file}`;
}
