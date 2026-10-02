import type { Database } from "better-sqlite3";
import type { InstructionId } from "./instruction-types";

export class InstructionConflictError extends Error {
  constructor() {
    super("These instructions changed since you started editing. Your draft is still here; compare it with the saved version before saving.");
    this.name = "InstructionConflictError";
  }
}

export interface InstructionOverride {
  id: InstructionId;
  content: string | null;
  version: number;
  updatedAt: number;
}

export function createInstructionStore(db: Database, now = Date.now) {
  const read = db.prepare("SELECT id, content, version, updated_at AS updatedAt FROM instruction_overrides WHERE id = ?");
  return {
    unpinnedCardIds(): string[] {
      return (db.prepare(`SELECT id FROM cards WHERE start_requested = 1
        AND NOT EXISTS (SELECT 1 FROM instruction_snapshots WHERE card_id = cards.id)`)
        .all() as Array<{ id: string }>).map(({ id }) => id);
    },
    pinned(cardId: string): string | null {
      const row = db.prepare("SELECT snapshot FROM instruction_snapshots WHERE card_id = ?").get(cardId) as { snapshot: string } | undefined;
      return row?.snapshot ?? null;
    },
    pin: db.transaction((cardId: string, snapshot: string): string => {
      db.prepare("INSERT INTO instruction_snapshots (card_id, snapshot) VALUES (?, ?) ON CONFLICT(card_id) DO NOTHING")
        .run(cardId, snapshot);
      return (db.prepare("SELECT snapshot FROM instruction_snapshots WHERE card_id = ?").get(cardId) as { snapshot: string }).snapshot;
    }),
    get(id: InstructionId): InstructionOverride | undefined {
      return read.get(id) as InstructionOverride | undefined;
    },
    all(): InstructionOverride[] {
      return db.prepare("SELECT id, content, version, updated_at AS updatedAt FROM instruction_overrides").all() as InstructionOverride[];
    },
    write: db.transaction((id: InstructionId, content: string | null, expectedVersion: number): InstructionOverride => {
      const current = read.get(id) as InstructionOverride | undefined;
      if ((current?.version ?? 0) !== expectedVersion) throw new InstructionConflictError();
      // Keep reset versions so an old tab cannot reuse the original default revision.
      db.prepare(`INSERT INTO instruction_overrides (id, content, version, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET content = excluded.content, version = excluded.version, updated_at = excluded.updated_at`)
        .run(id, content, expectedVersion + 1, now());
      return read.get(id) as InstructionOverride;
    }),
  };
}
