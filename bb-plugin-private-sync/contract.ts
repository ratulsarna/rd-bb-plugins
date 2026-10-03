import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  isNormalAbsolutePath,
  isSafeRelativePath,
  isWithin,
} from "./lib/paths";

/** Raw bytes per host RPC chunk. Base64 keeps it well under the 8 MiB result cap. */
export const CHUNK_BYTES = 4 * 1024 * 1024;

const relativePath = z
  .string()
  .refine(
    isSafeRelativePath,
    "Use a root-relative path without . or .. segments",
  );
const absolutePath = z
  .string()
  .refine(isNormalAbsolutePath, "Use a normalized absolute path other than /");
const hostId = z.string().min(1).max(200);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------
// Folder configuration

const nodeSchema = z.object({ hostId, path: absolutePath }).strict();

const folderFields = {
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use lowercase letters, digits, and -"),
  label: z.string().trim().min(1).max(80),
  nodes: z.array(nodeSchema).min(1).max(16),
  ignorePaths: z.array(relativePath).max(256).default([]),
};

function checkFolders(
  folders: readonly {
    id: string;
    primaryHostId?: string;
    nodes: readonly { hostId: string; path: string }[];
  }[],
  ctx: z.RefinementCtx,
) {
  const ids = new Set<string>();
  const roots: { hostId: string; path: string; folderId: string }[] = [];
  folders.forEach((folder, index) => {
    if (ids.has(folder.id))
      ctx.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `Duplicate folder id ${folder.id}`,
      });
    ids.add(folder.id);
    const hosts = new Set<string>();
    for (const node of folder.nodes) {
      if (hosts.has(node.hostId))
        ctx.addIssue({
          code: "custom",
          path: [index, "nodes"],
          message: `Folder ${folder.id} lists host ${node.hostId} twice`,
        });
      hosts.add(node.hostId);
      for (const other of roots) {
        if (
          other.hostId === node.hostId &&
          (isWithin(node.path, other.path) || isWithin(other.path, node.path))
        )
          ctx.addIssue({
            code: "custom",
            path: [index, "nodes"],
            message: `Folders ${other.folderId} and ${folder.id} overlap on host ${node.hostId}`,
          });
      }
      roots.push({ ...node, folderId: folder.id });
    }
    if (folder.primaryHostId !== undefined && !hosts.has(folder.primaryHostId))
      ctx.addIssue({
        code: "custom",
        path: [index, "primaryHostId"],
        message: `Folder ${folder.id}: the primary host must be one of its nodes`,
      });
  });
}

/** One synced folder as stored in settings. */
export const folderSchema = z
  .object({ ...folderFields, primaryHostId: hostId })
  .strict();
export type FolderConfig = z.infer<typeof folderSchema>;
export const foldersSchema = z
  .array(folderSchema)
  .max(32)
  .superRefine(checkFolders);

/** What `configure` accepts; a missing primaryHostId defaults to the server's own host. */
export const configInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    folders: z
      .array(
        z
          .object({ ...folderFields, primaryHostId: hostId.optional() })
          .strict(),
      )
      .max(32)
      .superRefine(checkFolders),
  })
  .strict();
export type ConfigInput = z.input<typeof configInputSchema>;

// ---------------------------------------------------------------------------
// Status

export const nodePhaseSchema = z.enum([
  "disabled",
  "paused",
  "offline",
  "waiting-for-primary",
  "pending",
  "syncing",
  "ready",
  "error",
]);
export type NodePhase = z.infer<typeof nodePhaseSchema>;

export const nodeStatusSchema = z.object({
  hostId,
  path: z.string(),
  phase: nodePhaseSchema,
  /**
   * A full pass finished in this config generation and nothing is outstanding.
   * Open conflicts do not block it: both sides are preserved as files.
   */
  ready: z.boolean(),
  /** Folder version this node last matched completely. */
  ackedVersion: z.number().int(),
  /** Folder versions committed since the node's acknowledged version. */
  lag: z.number().int(),
  /** Open conflicts this node created. */
  conflicts: z.number().int(),
  error: z.string().nullable(),
  lastSyncAt: z.number().nullable(),
});
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const conflictSchema = z.object({
  id: z.number().int(),
  path: z.string(),
  /** Where the losing side was preserved; null when a delete lost to an edit. */
  conflictPath: z.string().nullable(),
  hostId,
  kind: z.enum(["edit-edit", "edit-delete", "delete-edit"]),
  detectedAt: z.number(),
});
export type Conflict = z.infer<typeof conflictSchema>;

export const folderStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  primaryHostId: hostId,
  ignorePaths: z.array(z.string()),
  headVersion: z.number().int(),
  /** Newest open conflicts, at most 50. */
  conflicts: z.array(conflictSchema),
  openConflicts: z.number().int(),
  nodes: z.array(nodeStatusSchema),
});
export type FolderStatus = z.infer<typeof folderStatusSchema>;

export const syncStatusSchema = z.object({
  enabled: z.boolean(),
  paused: z.boolean(),
  /** Why the stored configuration could not be used, or null. */
  configError: z.string().nullable(),
  folders: z.array(folderStatusSchema),
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const resolvedPathSchema = z
  .object({ folderId: z.string(), root: z.string(), relativePath: z.string() })
  .nullable();
export type ResolvedPath = z.infer<typeof resolvedPathSchema>;

// ---------------------------------------------------------------------------
// Frontend RPC

export const rpcContract = defineRpcContract({
  machineDirectory: {
    input: z.null(),
    output: z.array(
      z.object({
        hostId: z.string(),
        name: z.string(),
        connected: z.boolean(),
      }),
    ),
  },
  status: { input: z.null(), output: syncStatusSchema },
  configure: { input: configInputSchema, output: syncStatusSchema },
  setEnabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: syncStatusSchema,
  },
  resolveConflict: {
    input: z.object({ folderId: z.string(), id: z.number().int().positive() }).strict(),
    output: syncStatusSchema,
  },
  pause: { input: z.null(), output: syncStatusSchema },
  resume: { input: z.null(), output: syncStatusSchema },
  /**
   * Blocks until the named nodes (default: all) finish a full pass started
   * after the call and match the head version. Fails on an offline node or
   * a failed pass.
   */
  sync: {
    input: z
      .object({
        folderId: z.string(),
        hostIds: z.array(hostId).max(16).optional(),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(30 * 60_000)
          .optional(),
      })
      .strict(),
    output: folderStatusSchema,
  },
  /** The configured folder that contains an absolute path on a host. */
  resolvePath: {
    input: z.object({ hostId, path: absolutePath }).strict(),
    output: resolvedPathSchema,
  },
});

/** Realtime channel published whenever status changes. */
export const STATUS_CHANGED = "status-changed";

// ---------------------------------------------------------------------------
// Host entry

const fileEntry = z
  .object({
    kind: z.literal("file"),
    hash: sha256,
    size: z.number().int().min(0),
    exec: z.boolean(),
  })
  .strict();
const symlinkEntry = z
  .object({ kind: z.literal("symlink"), target: z.string().min(1).max(4096) })
  .strict();
/** The content of one mirrored path. */
export const contentSchema = z.discriminatedUnion("kind", [
  fileEntry,
  symlinkEntry,
]);
export type Content = z.infer<typeof contentSchema>;

/** Equal content; null and undefined both mean absent. */
export function sameContent(
  a: Content | null | undefined,
  b: Content | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  if (a.kind === "file" && b.kind === "file")
    return a.hash === b.hash && a.exec === b.exec;
  if (a.kind === "symlink" && b.kind === "symlink")
    return a.target === b.target;
  return false;
}

/**
 * A scanned path; `mtimeMs` lets a later read prove the file did not change.
 * `busy` is a file that kept changing while it was hashed: present, content unknown.
 */
export const scanEntrySchema = z.union([
  fileEntry.extend({ path: relativePath, mtimeMs: z.number() }),
  symlinkEntry.extend({ path: relativePath }),
  z.object({ kind: z.literal("busy"), path: relativePath }).strict(),
]);
export type ScanEntry = z.infer<typeof scanEntrySchema>;

/** Physical directory accepted by a scan; strings retain filesystem integer precision. */
export const rootIdentitySchema = z.object({
  canonical: absolutePath,
  dev: z.string().regex(/^[0-9]+$/),
  ino: z.string().regex(/^[0-9]+$/),
}).strict();
export type RootIdentity = z.infer<typeof rootIdentitySchema>;

export function sameRoot(a: RootIdentity, b: RootIdentity): boolean {
  return a.canonical === b.canonical && a.dev === b.dev && a.ino === b.ino;
}

const boundRootInput = { root: absolutePath, identity: rootIdentitySchema };

const rootInput = {
  root: absolutePath,
  ignorePaths: z.array(relativePath).max(256),
};
/** What the target path must hold right now for a write to proceed; null means absent. */
const expected = contentSchema.nullable();
const applyResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      /** local-changed: the path no longer matches `expected`. blocked: a parent is a symlink or file. */
      reason: z.enum(["local-changed", "blocked"]),
    })
    .strict(),
]);
export type ApplyResult = z.infer<typeof applyResult>;

export const hostContract = defineRpcContract({
  /**
   * Walk a root (or only `paths` under it) and hash regular files. Results are
   * paged; read the remaining pages with scanPage.
   */
  scan: {
    input: z
      .object({
        ...rootInput,
        identity: rootIdentitySchema.nullable().default(null),
        paths: z.array(relativePath).max(512).optional(),
        /** Every other configured folder root on this host, checked before each pass. */
        otherRoots: z.array(absolutePath).max(31).default([]),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z
        .object({
          ok: z.literal(true),
          scanId: z.string(),
          identity: rootIdentitySchema,
          pages: z.number().int().min(1),
          entries: z.array(scanEntrySchema),
          /** Symlinks leaving the root and special files, which are never mirrored. */
          skipped: z.number().int(),
          /** The root holds no mirrored file at all, whatever `paths` covered. */
          empty: z.boolean(),
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          reason: z.enum(["root-missing", "unsafe-root", "root-changed", "overlapping-roots"]),
        })
        .strict(),
    ]),
  },
  checkRoot: {
    input: z.object(boundRootInput).strict(),
    output: z.null(),
  },
  scanPage: {
    input: z
      .object({ scanId: z.string(), page: z.number().int().min(1) })
      .strict(),
    output: z.object({ entries: z.array(scanEntrySchema) }).strict(),
  },
  /**
   * Read byte ranges of several files, at most CHUNK_BYTES in total. A range
   * is `changed` when its file is no longer the scanned one.
   */
  read: {
    input: z
      .object({
        ...boundRootInput,
        ranges: z
          .array(
            z
              .object({
                path: relativePath,
                offset: z.number().int().min(0),
                length: z.number().int().min(0).max(CHUNK_BYTES),
                size: z.number().int().min(0),
                mtimeMs: z.number(),
              })
              .strict(),
          )
          .min(1)
          .max(4096)
          .refine(
            (ranges) =>
              ranges.reduce((sum, range) => sum + range.length, 0) <=
              CHUNK_BYTES,
            "At most CHUNK_BYTES per read",
          ),
      })
      .strict(),
    output: z
      .object({
        results: z.array(
          z.discriminatedUnion("ok", [
            z.object({ ok: z.literal(true), data: z.string() }).strict(),
            z
              .object({ ok: z.literal(false), reason: z.literal("changed") })
              .strict(),
          ]),
        ),
      })
      .strict(),
  },
  /**
   * Append chunks to temporary files beside their targets. An item with
   * `commit` then verifies the whole temporary file's hash and the target's
   * expected content, and publishes it without overwriting a concurrent save.
   */
  write: {
    input: z
      .object({
        ...boundRootInput,
        items: z
          .array(
            z
              .object({
                path: relativePath,
                tempId: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
                offset: z.number().int().min(0),
                data: z.string(),
                commit: z
                  .object({ content: fileEntry, expected })
                  .strict()
                  .nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(4096),
      })
      .strict(),
    output: z.object({ results: z.array(applyResult) }).strict(),
  },
  link: {
    input: z
      .object({
        ...boundRootInput,
        path: relativePath,
        target: z.string().min(1).max(4096),
        expected,
      })
      .strict(),
    output: applyResult,
  },
  remove: {
    input: z
      .object({
        ...boundRootInput,
        path: relativePath,
        expected: contentSchema,
      })
      .strict(),
    output: applyResult,
  },
  /** Replace this worker's set of watched folders. */
  watch: {
    input: z
      .object({
        folders: z
          .array(z.object({ folderId: z.string(), ...rootInput }).strict())
          .max(64),
      })
      .strict(),
    output: z.object({ watching: z.number().int() }).strict(),
  },
});

export const hostSignals = {
  /** Something under a watched root changed; `paths` is null when the host lost track. */
  changed: {
    payload: z
      .object({
        folderId: z.string(),
        paths: z.array(relativePath).max(512).nullable(),
      })
      .strict(),
  },
} satisfies ExperimentalHostSignals;
