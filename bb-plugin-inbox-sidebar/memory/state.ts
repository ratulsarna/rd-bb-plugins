// Each assistant's memory state, as a file beside its log and tree. Not in data.db: a plugin rollback
// restores the database, and old bindings must never run against a tree that has moved on.
import fs from "node:fs";
import path from "node:path";

export type MemoryState = {
  on: boolean;
  /** Set at the first `on`; an import is refused once true, since live logging owns the log from then. */
  everOn: boolean;
  /** The current main chat; null after it was archived or deleted by hand. */
  main: string | null;
  /** When memory was last turned on: a compaction before it is not news. A successor's events all come later. */
  since: number;
  /** Earlier main chats a stopped handover kept live: still logged, and rotation waits until they are archived. */
  previous: string[];
  /** Newest last. */
  warnings: Array<{ at: number; text: string }>;
  import: { sources: string[]; done: number; error: string | null } | null;
};

export const KEPT_WARNINGS = 20;

export const emptyState = (): MemoryState => ({ on: false, everOn: false, main: null, since: 0, previous: [], warnings: [], import: null });

const PROJECT = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

/** `<projectId>:<home segment>` as one directory name; anything that is not two safe path parts is refused. */
export function dirName(identity: string): string {
  const k = identity.indexOf(":");
  const [project, segment] = [identity.slice(0, k), identity.slice(k + 1)];
  if (k < 0 || !PROJECT.test(project) || !segment || segment === "." || segment === ".." || /[/\\\u0000-\u001f]/.test(segment)) {
    throw new Error(`not an assistant identity: ${identity}`);
  }
  return `${project}__${segment}`;
}

/** Identities with a memory dir under `root`. */
export function identities(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.includes("__"))
    .map((e) => e.name.replace("__", ":"));
}

export function readState(dir: string): MemoryState {
  const file = path.join(dir, "memory.json");
  return fs.existsSync(file) ? { ...emptyState(), ...JSON.parse(fs.readFileSync(file, "utf8")) } : emptyState();
}

export function writeState(dir: string, state: MemoryState): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "memory.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { flush: true });
  fs.renameSync(tmp, path.join(dir, "memory.json"));
}
