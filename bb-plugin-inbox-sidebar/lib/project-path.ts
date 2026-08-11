const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:(?:[\\/]+)?$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:(?:[\\/]+)/u;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\/]+(?:[\\/]+)[^\\/]+/u;

export function normalizeProjectPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/u, "");
}

export function getProjectPathError(path: string): string | null {
  const normalized = normalizeProjectPath(path);
  if (
    WINDOWS_DRIVE_ROOT_PATTERN.test(normalized) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized) ||
    WINDOWS_UNC_PATH_PATTERN.test(normalized)
  ) {
    return "Use a POSIX path such as /home/me/repo or /mnt/c/Users/me/repo.";
  }
  if (!normalized || !normalized.startsWith("/")) {
    return "Project path must be an absolute path.";
  }
  if (normalized === "/") {
    return "Choose a project folder, not the filesystem root.";
  }
  return null;
}

export function projectNameFromPath(path: string): string {
  if (getProjectPathError(path)) return "";
  return normalizeProjectPath(path).split("/").filter(Boolean).at(-1) ?? "";
}
