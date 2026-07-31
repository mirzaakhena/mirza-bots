import { Database } from "bun:sqlite";

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

export function searchMessages(db: Database, query: string): Array<{ id: number; text: string }> {
  return db
    .query(
      `SELECT m.id, m.text FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?`
    )
    .all(query) as Array<{ id: number; text: string }>;
}
