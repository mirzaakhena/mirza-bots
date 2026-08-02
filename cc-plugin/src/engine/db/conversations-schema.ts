import { Database } from "bun:sqlite";
import type { HistoryMessage } from "../types";

// Table only. Indexes, FTS and triggers come after addMissingColumns() below,
// because idx_messages_session cannot be created until session_id exists on a
// database that predates it.
const TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  bot TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  source TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  text TEXT,
  attachments TEXT,
  reply_to TEXT,
  metadata TEXT,
  session_id TEXT
);
`;

const INDEXES_AND_FTS = `
CREATE INDEX IF NOT EXISTS idx_messages_bot ON messages(bot);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(bot, chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(bot, message_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

// Columns added after Tahap 1 shipped. `CREATE TABLE IF NOT EXISTS` does nothing
// to a table that already exists, so a database carrying real history would keep
// the old shape forever and every insert would fail. Guarded by table_info so it
// is idempotent -- SQLite has no `ADD COLUMN IF NOT EXISTS`.
const ADDED_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "session_id", ddl: "ALTER TABLE messages ADD COLUMN session_id TEXT" },
];

function addMissingColumns(db: Database): void {
  const existing = new Set(
    (db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const col of ADDED_COLUMNS) {
    if (!existing.has(col.name)) db.exec(col.ddl);
  }
}

export function openConversationsDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  // WAL already lets readers and writers run in parallel, but two writers
  // still serialise. Up to six sessions now open this file instead of one
  // daemon, so the loser of a write race must WAIT rather than fail --
  // SQLITE_BUSY surfaces as a random, hard-to-trace error at the call site.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(TABLE);
  addMissingColumns(db);
  db.exec(INDEXES_AND_FTS);
  return db;
}

export type NewMessage = {
  ts: string;
  bot: string;
  chatId: string;
  messageId?: string;
  source: string;
  userId?: string;
  userName?: string;
  text?: string;
  attachments?: string;
  replyTo?: string;
  metadata?: string;
  sessionId?: string;
};

export function insertMessage(db: Database, msg: NewMessage): number {
  const result = db
    .query(
      `INSERT INTO messages (ts, bot, chat_id, message_id, source, user_id, user_name, text, attachments, reply_to, metadata, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      msg.ts,
      msg.bot,
      msg.chatId,
      msg.messageId ?? null,
      msg.source,
      msg.userId ?? null,
      msg.userName ?? null,
      msg.text ?? null,
      msg.attachments ?? null,
      msg.replyTo ?? null,
      msg.metadata ?? null,
      msg.sessionId ?? null
    );
  return Number(result.lastInsertRowid);
}

/**
 * What goes in the `metadata` JSON column. One declared shape rather than
 * ad-hoc object literals at each call site, because three different features
 * (quotes, albums, documents) write into the same column and every reader --
 * including the history tool -- has to parse whatever they agreed on.
 *
 * NOTE: `kind` here is the ATTACHMENT kind (photo/album/document). It is not the
 * same field as `meta.kind` on a PushMessage, which is message-vs-callback.
 */
export type MessageMetadata = {
  quote_text?: string;
  quote_is_manual?: boolean;
  message_ids?: string[];
  kind?: "photo" | "album" | "document";
};

/**
 * Serializes metadata, or returns undefined when there is genuinely nothing to
 * record -- so the column holds NULL rather than the string "{}", which every
 * later reader would have to special-case as "present but empty".
 */
export function encodeMetadata(meta: MessageMetadata): string | undefined {
  const entries = Object.entries(meta).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : undefined;
}

const HISTORY_COLUMNS = `m.id AS id, m.ts AS ts, m.bot AS bot, m.chat_id AS chatId,
  m.message_id AS messageId, m.source AS source, m.user_name AS userName, m.text AS text,
  m.reply_to AS replyTo, m.metadata AS metadata`;

/**
 * Messages around a given Telegram message id, in chronological order.
 *
 * `bot` is required, never defaulted here: K-3 puts the "default to the caller,
 * cross bots only on request" decision at the socket handler, which is the one
 * place that knows who is asking. A default in this function would silently
 * change what every existing caller of the module sees.
 *
 * Returns [] when the anchor is unknown -- deliberately NOT "the newest
 * messages", which would let the AI answer confidently about a message that was
 * never found.
 */
export function getMessagesAround(
  db: Database,
  opts: { bot: string; messageId: string; before: number; after: number }
): HistoryMessage[] {
  const anchor = db
    .query("SELECT id FROM messages WHERE bot = ? AND message_id = ? ORDER BY id DESC LIMIT 1")
    .get(opts.bot, opts.messageId) as { id: number } | null;
  if (!anchor) return [];

  const preceding = (
    opts.before > 0
      ? (db
          .query(
            `SELECT ${HISTORY_COLUMNS} FROM messages m WHERE m.bot = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`
          )
          .all(opts.bot, anchor.id, opts.before) as HistoryMessage[])
      : []
  ).reverse();

  const anchorRow = db
    .query(`SELECT ${HISTORY_COLUMNS} FROM messages m WHERE m.id = ?`)
    .get(anchor.id) as HistoryMessage;

  const following =
    opts.after > 0
      ? (db
          .query(
            `SELECT ${HISTORY_COLUMNS} FROM messages m WHERE m.bot = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`
          )
          .all(opts.bot, anchor.id, opts.after) as HistoryMessage[])
      : [];

  return [...preceding, anchorRow, ...following];
}

/**
 * FTS5 keyword search. `opts.bot` is optional here for the same reason as above:
 * the bot-scoping decision lives at the socket handler. Existing callers that
 * pass no options keep their unfiltered behaviour.
 *
 * Throws on a malformed query (verified: an unbalanced quote gives
 * "unterminated string"). Deliberately not swallowed -- a silent [] would be
 * indistinguishable from "no matches", and the AI writes these queries.
 */
export function searchMessages(
  db: Database,
  query: string,
  opts: { bot?: string; limit?: number } = {}
): HistoryMessage[] {
  const limit = opts.limit ?? 20;
  if (opts.bot !== undefined) {
    return db
      .query(
        `SELECT ${HISTORY_COLUMNS} FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? AND m.bot = ? ORDER BY m.id DESC LIMIT ?`
      )
      .all(query, opts.bot, limit) as HistoryMessage[];
  }
  return db
    .query(
      `SELECT ${HISTORY_COLUMNS} FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? ORDER BY m.id DESC LIMIT ?`
    )
    .all(query, limit) as HistoryMessage[];
}
