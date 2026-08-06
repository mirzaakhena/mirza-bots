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

// Tabelnya sendiri, bukan kolom di `messages`: yang disimpan adalah fakta
// tentang SESI, bukan tentang sebuah pesan. Menempelkannya ke messages berarti
// mengulang nilai yang sama di tiap baris dan membuat "mana yang pertama"
// bergantung pada urutan id -- pertanyaan yang tidak perlu ada.
const SESSION_FIRST_NAME = `
CREATE TABLE IF NOT EXISTS session_first_name (
  session_id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL
);
`;

// Satu baris, dan `CHECK (id = 1)` yang menjaminnya. Berkas database ini memang
// milik SATU bot, jadi pertanyaannya bukan "sesi ini sudah diumumkan?" (yang
// akan butuh satu baris per sesi) melainkan "nama terakhir yang kuumumkan apa?".
// Pertanyaan itu melintasi sesi: sesudah `/clear` nama warisannya sama persis,
// dan mengumumkannya lagi berarti mengumumkan sesuatu yang tidak berubah.
const NOTIFIED_SESSION_NAME = `
CREATE TABLE IF NOT EXISTS notified_session_name (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL
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
  db.exec(SESSION_FIRST_NAME);
  db.exec(NOTIFIED_SESSION_NAME);
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
 * TIDAK ADA penyaring `bot`, dan itu keputusan, bukan kelalaian. Sesudah state
 * per-folder, berkas database ini milik SATU bot, jadi filternya tidak
 * menyaring apa pun -- tapi begitu foldernya di-rename (cara resmi memindahkan
 * bot sekarang), baris lama membawa nama lama dan filternya mulai membuang
 * riwayat DIAM-DIAM. Kolom `bot` tetap ditulis sebagai jejak; membuang kolomnya
 * adalah keputusan user yang belum diambil.
 *
 * Returns [] when the anchor is unknown -- deliberately NOT "the newest
 * messages", which would let the AI answer confidently about a message that was
 * never found.
 */
/**
 * ⚠️ `m.source <> 'system'` di bawah bukan detail, dan ia ada di TIGA tempat:
 * dua di sini, satu di `searchMessages`.
 *
 * Baris `system` adalah pengingat mesin (kanal `[from: system]`). Ia DISIMPAN
 * supaya bisa dihitung — "berapa sering sebuah pengingat menyala" adalah angka
 * yang spec kanal itu sendiri tuntut, dan pesan yang tidak meninggalkan jejak
 * tidak bisa diukur belakangan (pelajaran AB-1). Tapi ia BUKAN percakapan:
 * memunculkannya di `read_history`/`search_history` akan membuat AI membaca
 * ulang perintah mesin sebagai sesuatu yang pernah dikatakan seseorang.
 *
 * Menyimpan-lalu-menyaring dipilih di atas tidak-menyimpan karena arah galatnya
 * berbeda jauh: penyaring yang lupa dipasang bisa diperbaiki kapan saja, data
 * yang tidak pernah dicatat tidak bisa.
 */
export function getMessagesAround(
  db: Database,
  opts: { messageId: string; before: number; after: number }
): HistoryMessage[] {
  const anchor = db
    .query("SELECT id FROM messages WHERE message_id = ? ORDER BY id DESC LIMIT 1")
    .get(opts.messageId) as { id: number } | null;
  if (!anchor) return [];

  const preceding = (
    opts.before > 0
      ? (db
          .query(
            `SELECT ${HISTORY_COLUMNS} FROM messages m WHERE m.id < ? AND m.source <> 'system' ORDER BY m.id DESC LIMIT ?`
          )
          .all(anchor.id, opts.before) as HistoryMessage[])
      : []
  ).reverse();

  const anchorRow = db
    .query(`SELECT ${HISTORY_COLUMNS} FROM messages m WHERE m.id = ?`)
    .get(anchor.id) as HistoryMessage;

  const following =
    opts.after > 0
      ? (db
          .query(
            `SELECT ${HISTORY_COLUMNS} FROM messages m WHERE m.id > ? AND m.source <> 'system' ORDER BY m.id ASC LIMIT ?`
          )
          .all(anchor.id, opts.after) as HistoryMessage[])
      : [];

  return [...preceding, anchorRow, ...following];
}

/**
 * Chat_id TERBARU yang tercatat di database ini (W-27).
 *
 * Dipakai sebagai fallback saat `lastChatByBot` di memori proses kosong --
 * paling sering karena engine baru saja restart. TIDAK ADA penyaring `bot`,
 * alasannya sama persis dengan getMessagesAround di atas: sesudah state
 * per-folder, berkas database ini milik SATU bot.
 *
 * `id DESC`, bukan `ts DESC`: `id` AUTOINCREMENT selalu naik mengikuti urutan
 * INSERT yang sebenarnya terjadi, sedangkan `ts` datang dari luar (jam
 * Telegram di sisi pengirim) dan bisa kembar atau tidak monoton.
 *
 * Sengaja BUKAN sumber fallback lain seperti `allowFrom[0]` di config: kolom
 * ini mencatat chat yang BENAR-BENAR pernah terjadi, sedangkan allowFrom
 * cuma daftar siapa yang BOLEH -- mengambil entri pertamanya kalau daftar itu
 * lebih dari satu berarti menebak, dan salah kirim ke orang lain lebih buruk
 * daripada menolak mengirim sama sekali.
 */
/**
 * Berapa giliran user sudah berjalan di sebuah sesi Claude Code.
 *
 * Dibaca dari database yang sudah ada, bukan dari penghitung tersendiri.
 * Penghitung terpisah adalah state kedua untuk satu fakta, dan menyimpangnya
 * tidak akan terlihat oleh siapa pun sampai keputusan yang bergantung padanya
 * salah.
 *
 * `source = 'user'` bukan detail: satu pertanyaan yang dijawab tiga pesan bukan
 * tiga giliran percakapan, dan pengingat yang menghitung balasan bot akan
 * menyala jauh lebih cepat daripada yang dimaksudkan.
 */
/**
 * Nama sesi yang PERTAMA terlihat untuk sebuah `session_id`.
 *
 * ## Kenapa tabel ini ada
 *
 * Uji hidup 2026-08-06 membatalkan asumsi dasar fitur penamaan: di Claude Code,
 * nama sesi adalah milik JENDELANYA, bukan milik percakapannya. Sesudah
 * `/clear`, sesi baru LAHIR dengan nama lama sudah menempel -- baris pertama
 * transcriptnya sendiri berbunyi
 * `{"type":"custom-title","customTitle":"uji-engine-mati","sessionId":"<id BARU>"}`.
 *
 * Ketiganya sepakat menyebut nama lama: judul tab, `status.json`, dan
 * transcript. Jadi TIDAK ADA satu pun tempat yang bisa ditanya "sesi ini belum
 * bernama?" -- pertanyaan itu tidak punya jawaban di sistem.
 *
 * Yang punya jawaban adalah pertanyaan lain: **"namanya berubah sejak sesi ini
 * lahir?"**. Tabel ini menyimpan pembandingnya.
 *
 * ## Kenapa `INSERT OR IGNORE`, bukan upsert
 *
 * Yang dicatat adalah nama SAAT LAHIR, dan itu tidak boleh bergeser. Kalau tiap
 * pemanggilan menimpanya, pembandingnya ikut bergerak mengikuti nama sekarang
 * dan perbandingannya selalu menjawab "sama" -- guard yang selalu mengatakan
 * ya adalah guard yang tidak menjaga apa pun.
 */
export function rememberFirstSessionName(db: Database, sessionId: string, name: string): void {
  db.query("INSERT OR IGNORE INTO session_first_name (session_id, first_name) VALUES (?, ?)").run(
    sessionId,
    name
  );
}

/** `null` = sesi ini belum pernah tercatat. String kosong = sesi lahir tanpa nama. */
export function getFirstSessionName(db: Database, sessionId: string): string | null {
  const row = db
    .query("SELECT first_name FROM session_first_name WHERE session_id = ?")
    .get(sessionId) as { first_name: string } | null;
  return row ? row.first_name : null;
}

/**
 * Mencatat nama sesi yang BARU SAJA diumumkan ke Telegram.
 *
 * `INSERT OR REPLACE`, kebalikan dari `rememberFirstSessionName` — dan
 * perbedaan itu disengaja. Yang di sana adalah patokan yang tidak boleh
 * bergerak; yang di sini adalah "terakhir kali", yang justru harus selalu
 * mengikuti kenyataan.
 */
export function rememberNotifiedSessionName(db: Database, name: string): void {
  db.query("INSERT OR REPLACE INTO notified_session_name (id, name) VALUES (1, ?)").run(name);
}

/** `null` = bot ini belum pernah mengumumkan nama sesi apa pun. */
export function getNotifiedSessionName(db: Database): string | null {
  const row = db.query("SELECT name FROM notified_session_name WHERE id = 1").get() as
    | { name: string }
    | null;
  return row ? row.name : null;
}

export function countUserTurns(db: Database, sessionId: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND source = 'user'")
    .get(sessionId) as { n: number } | null;
  return row ? row.n : 0;
}

export function getLastChatId(db: Database): string | null {
  const row = db.query("SELECT chat_id FROM messages ORDER BY id DESC LIMIT 1").get() as
    | { chat_id: string }
    | null;
  return row ? row.chat_id : null;
}

/**
 * FTS5 keyword search atas database milik bot ini. Tanpa penyaring `bot`,
 * alasannya sama persis dengan getMessagesAround di atas.
 *
 * Throws on a malformed query (verified: an unbalanced quote gives
 * "unterminated string"). Deliberately not swallowed -- a silent [] would be
 * indistinguishable from "no matches", and the AI writes these queries.
 */
export function searchMessages(
  db: Database,
  query: string,
  opts: { limit?: number } = {}
): HistoryMessage[] {
  return db
    .query(
      `SELECT ${HISTORY_COLUMNS} FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? AND m.source <> 'system' ORDER BY m.id DESC LIMIT ?`
    )
    .all(query, opts.limit ?? 20) as HistoryMessage[];
}
