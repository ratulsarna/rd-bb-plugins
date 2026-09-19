import type { Database } from "better-sqlite3";
import type { Column } from "./columns";

export interface CardAttachment {
  path: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  isImage: boolean;
}

export interface Card {
  id: string;
  projectId: string;
  title: string;
  body: string;
  attachments: CardAttachment[];
  column: Column;
  needsUser: boolean;
  attentionReason: string | null;
  attentionSource: string | null;
  attentionUnknown: boolean;
  reportSignal: "needs_you" | "working" | null;
  tier: "trivial" | "small" | "standard" | null;
  issueUrl: string | null;
  prUrl: string | null;
  intakeThreadId: string | null;
  leadThreadId: string | null;
  threadError: string | null;
  launchError: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CardHistory {
  id: number;
  cardId: string;
  at: number;
  kind: string;
  fromColumn: Column | null;
  toColumn: Column | null;
  source: string;
  threadId: string | null;
  note: string | null;
}

export interface HistoryInput {
  kind: string;
  fromColumn?: Column | null;
  toColumn?: Column | null;
  source: string;
  threadId?: string | null;
  note?: string | null;
}

export type CardPatch = Partial<
  Pick<
    Card,
    | "column"
    | "needsUser"
    | "attentionReason"
    | "attentionSource"
    | "attentionUnknown"
    | "reportSignal"
    | "tier"
    | "issueUrl"
    | "prUrl"
    | "intakeThreadId"
    | "leadThreadId"
    | "threadError"
    | "launchError"
  >
>;

interface CardRow {
  id: string;
  project_id: string;
  title: string;
  body: string;
  attachments: string;
  column: Column;
  needs_user: number;
  attention_reason: string | null;
  attention_source: string | null;
  attention_unknown: number;
  report_signal: "needs_you" | "working" | null;
  tier: "trivial" | "small" | "standard" | null;
  issue_url: string | null;
  pr_url: string | null;
  intake_thread_id: string | null;
  lead_thread_id: string | null;
  thread_error: string | null;
  launch_error: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface HistoryRow {
  id: number;
  card_id: string;
  at: number;
  kind: string;
  from_column: Column | null;
  to_column: Column | null;
  source: string;
  thread_id: string | null;
  note: string | null;
}

export const MIGRATIONS = [
  `CREATE TABLE cards (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', attachments TEXT NOT NULL DEFAULT '[]',
    "column" TEXT NOT NULL,
    needs_user INTEGER NOT NULL DEFAULT 0, attention_reason TEXT, attention_source TEXT, attention_unknown INTEGER NOT NULL DEFAULT 0,
    report_signal TEXT,
    tier TEXT, issue_url TEXT, pr_url TEXT,
    intake_thread_id TEXT, lead_thread_id TEXT, thread_error TEXT, launch_error TEXT,
    revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE card_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    at INTEGER NOT NULL, kind TEXT NOT NULL, from_column TEXT, to_column TEXT, source TEXT NOT NULL, thread_id TEXT, note TEXT
  );
  CREATE INDEX cards_project ON cards(project_id, updated_at);
  CREATE INDEX cards_intake ON cards(intake_thread_id);
  CREATE INDEX cards_lead ON cards(lead_thread_id);`,
] as const;

function parseAttachments(value: string): CardAttachment[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as CardAttachment[]) : [];
  } catch {
    return [];
  }
}

function cardFromRow(row: CardRow): Card {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    attachments: parseAttachments(row.attachments),
    column: row.column,
    needsUser: row.needs_user === 1,
    attentionReason: row.attention_reason,
    attentionSource: row.attention_source,
    attentionUnknown: row.attention_unknown === 1,
    reportSignal: row.report_signal,
    tier: row.tier,
    issueUrl: row.issue_url,
    prUrl: row.pr_url,
    intakeThreadId: row.intake_thread_id,
    leadThreadId: row.lead_thread_id,
    threadError: row.thread_error,
    launchError: row.launch_error,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function historyFromRow(row: HistoryRow): CardHistory {
  return {
    id: row.id,
    cardId: row.card_id,
    at: row.at,
    kind: row.kind,
    fromColumn: row.from_column,
    toColumn: row.to_column,
    source: row.source,
    threadId: row.thread_id,
    note: row.note,
  };
}

export interface CardStore {
  create(input: {
    id: string;
    projectId: string;
    title: string;
    body: string;
    attachments: CardAttachment[];
    source: string;
  }): Card;
  get(id: string): Card | null;
  getByThread(threadId: string): Card | null;
  list(projectId: string, includeDone?: boolean): Card[];
  listActiveWithOwner(): Card[];
  update(id: string, patch: CardPatch, history?: HistoryInput): Card;
  recordHistory(id: string, history: HistoryInput): void;
  history(id: string): CardHistory[];
  remove(id: string, source: string): boolean;
}

export function createCardStore(db: Database, now = Date.now): CardStore {
  const getRow = db.prepare("SELECT * FROM cards WHERE id = ?");
  const insertHistory = db.prepare(
    `INSERT INTO card_history
      (card_id, at, kind, from_column, to_column, source, thread_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const addHistory = (id: string, input: HistoryInput): void => {
    insertHistory.run(
      id,
      now(),
      input.kind,
      input.fromColumn ?? null,
      input.toColumn ?? null,
      input.source,
      input.threadId ?? null,
      input.note ?? null,
    );
  };

  const read = (id: string): Card | null => {
    const row = getRow.get(id) as CardRow | undefined;
    return row === undefined ? null : cardFromRow(row);
  };

  const write = db.transaction(
    (id: string, patch: CardPatch, history?: HistoryInput): Card => {
      const current = read(id);
      if (current === null) throw new Error(`unknown card ${id}`);
      const next = { ...current, ...patch, updatedAt: now() };
      db.prepare(
        `UPDATE cards SET
          "column" = ?, needs_user = ?, attention_reason = ?, attention_source = ?, attention_unknown = ?,
          report_signal = ?, tier = ?, issue_url = ?, pr_url = ?, intake_thread_id = ?, lead_thread_id = ?,
          thread_error = ?, launch_error = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.column,
        next.needsUser ? 1 : 0,
        next.attentionReason,
        next.attentionSource,
        next.attentionUnknown ? 1 : 0,
        next.reportSignal,
        next.tier,
        next.issueUrl,
        next.prUrl,
        next.intakeThreadId,
        next.leadThreadId,
        next.threadError,
        next.launchError,
        next.updatedAt,
        id,
      );
      if (history !== undefined) addHistory(id, history);
      return read(id)!;
    },
  );

  return {
    create: db.transaction((input) => {
      const at = now();
      db.prepare(
        `INSERT INTO cards
          (id, project_id, title, body, attachments, "column", created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?)`,
      ).run(
        input.id,
        input.projectId,
        input.title,
        input.body,
        JSON.stringify(input.attachments),
        at,
        at,
      );
      addHistory(input.id, { kind: "created", source: input.source });
      return read(input.id)!;
    }),
    get: read,
    getByThread(threadId) {
      const row = db
        .prepare(
          "SELECT * FROM cards WHERE intake_thread_id = ? OR lead_thread_id = ? LIMIT 1",
        )
        .get(threadId, threadId) as CardRow | undefined;
      return row === undefined ? null : cardFromRow(row);
    },
    list(projectId, includeDone = false) {
      const rows = db
        .prepare(
          `SELECT * FROM cards WHERE project_id = ?${includeDone ? "" : ` AND "column" <> 'done'`}
           ORDER BY updated_at DESC, created_at DESC`,
        )
        .all(projectId) as CardRow[];
      return rows.map(cardFromRow);
    },
    listActiveWithOwner() {
      return (
        db
          .prepare(
            `SELECT * FROM cards
             WHERE "column" <> 'done' AND (lead_thread_id IS NOT NULL OR intake_thread_id IS NOT NULL)
             ORDER BY updated_at DESC`,
          )
          .all() as CardRow[]
      ).map(cardFromRow);
    },
    update(id, patch, history) {
      return write(id, patch, history);
    },
    recordHistory(id, history) {
      if (read(id) === null) throw new Error(`unknown card ${id}`);
      addHistory(id, history);
    },
    history(id) {
      return (
        db
          .prepare("SELECT * FROM card_history WHERE card_id = ? ORDER BY id")
          .all(id) as HistoryRow[]
      ).map(historyFromRow);
    },
    remove: db.transaction((id: string, source: string) => {
      if (read(id) === null) return false;
      addHistory(id, { kind: "removed", source });
      db.prepare("DELETE FROM cards WHERE id = ?").run(id);
      return true;
    }),
  };
}
