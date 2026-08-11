export interface PathCrumb {
  label: string;
  path: string;
}

export function toBreadcrumb(directory: string): PathCrumb[] {
  if (!/^[A-Za-z]:/.test(directory)) {
    const crumbs: PathCrumb[] = [{ label: "/", path: "/" }];
    let path = "";
    for (const segment of directory.split("/").filter(Boolean)) {
      path = `${path}/${segment}`;
      crumbs.push({ label: segment, path });
    }
    return crumbs;
  }

  const segments = directory.replace(/\//g, "\\").split("\\").filter(Boolean);
  const drive = segments[0] ?? "";
  const crumbs: PathCrumb[] = [{ label: drive, path: `${drive}\\` }];
  let path = drive;
  for (const segment of segments.slice(1)) {
    path = `${path}\\${segment}`;
    crumbs.push({ label: segment, path });
  }
  return crumbs;
}

export function joinHostPath(directory: string, name: string): string {
  if (/^[A-Za-z]:/.test(directory)) {
    return `${directory.replace(/[\\/]+$/, "")}\\${name}`;
  }
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

export function getFolderNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return "Enter a folder name.";
  }
  if (/[\\/]/.test(trimmed)) return "Folder names can't contain slashes.";
  return null;
}
