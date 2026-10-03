import { createHash } from "node:crypto";
import { posix } from "node:path";

/** Keep complete UTF-8 code points inside the filesystem's basename byte budget. */
function truncate(value: string, bytes: number): string {
  let result = "";
  for (const point of value) {
    bytes -= Buffer.byteLength(point);
    if (bytes < 0) break;
    result += point;
  }
  return result;
}

/** `notes/a.md` → `notes/a.sync-conflict-20261003-012233-host1.md`. */
export function conflictPath(
  path: string,
  hostId: string,
  at: Date,
  attempt = 0,
  reserveBytes = 0,
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
  let file = `${stem}.sync-conflict-${stamp}-${host}${suffix}${ext}`;
  const limit = 255 - reserveBytes;
  if (Buffer.byteLength(file) > limit) {
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
    const tail = `.sync-conflict-${stamp}-${host}-${digest}${suffix}`;
    const extension = truncate(ext, 32);
    file = `${truncate(stem, limit - Buffer.byteLength(tail + extension))}${tail}${extension}`;
  }
  return dir === "." ? file : `${dir}/${file}`;
}
