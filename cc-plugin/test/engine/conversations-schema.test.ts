import { describe, test, expect } from "bun:test";
import {
  openConversationsDb,
  insertMessage,
  searchMessages,
  getMessagesAround,
  countUserTurns,
} from "../../src/engine/db/conversations-schema";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("conversations.db schema", () => {
  test("inserted message is searchable via FTS5", () => {
    const db = openConversationsDb(":memory:");
    insertMessage(db, {
      ts: "2026-07-30T00:00:00Z",
      bot: "bot-01",
      chatId: "999",
      source: "user",
      text: "tolong cek status backup fleetd",
    });

    const hits = searchMessages(db, "backup");
    expect(hits.length).toBe(1);
    expect(hits[0]?.text).toContain("backup");
  });

  test("unrelated keyword returns no hits", () => {
    const db = openConversationsDb(":memory:");
    insertMessage(db, {
      ts: "2026-07-30T00:00:00Z",
      bot: "bot-01",
      chatId: "999",
      source: "user",
      text: "tolong cek status backup fleetd",
    });

    expect(searchMessages(db, "unicorn").length).toBe(0);
  });

  test("FTS index follows UPDATE and DELETE on messages", () => {
    const db = openConversationsDb(":memory:");
    const id = insertMessage(db, {
      ts: "2026-07-30T00:00:00Z",
      bot: "bot-01",
      chatId: "999",
      source: "user",
      text: "tolong cek status backup fleetd",
    });

    expect(searchMessages(db, "backup").length).toBe(1);

    db.query("UPDATE messages SET text = ? WHERE id = ?").run("status restore selesai", id);

    expect(searchMessages(db, "backup").length).toBe(0);
    const updatedHits = searchMessages(db, "restore");
    expect(updatedHits.length).toBe(1);
    expect(updatedHits[0]?.text).toContain("restore");

    db.query("DELETE FROM messages WHERE id = ?").run(id);

    expect(searchMessages(db, "restore").length).toBe(0);
  });
});

describe("session_id column", () => {
  test("session_id is stored and read back", () => {
    const db = openConversationsDb(":memory:");
    insertMessage(db, {
      ts: "2026-07-31T00:00:00Z",
      bot: "bot-01",
      chatId: "111",
      source: "user",
      text: "halo",
      sessionId: "a3760589-1111-2222-3333-444444444444",
    });

    const row = db.query("SELECT session_id FROM messages").get() as { session_id: string };
    expect(row.session_id).toBe("a3760589-1111-2222-3333-444444444444");
  });

  test("an existing conversations.db created before session_id gets the column without losing rows", () => {
    // The real database on disk was created by Tahap 1's CREATE TABLE, which has
    // no session_id. `CREATE TABLE IF NOT EXISTS` is a no-op against it, so
    // without an explicit ALTER the very first insert after this change would
    // fail with "table messages has no column named session_id" -- on the user's
    // live history, not in a test.
    // The FTS table and its triggers are part of the legacy shape on purpose:
    // the ALTER runs against a table that already has a POPULATED fts5
    // external-content index attached. Every other test in this file uses a
    // fresh in-memory database where session_id comes from CREATE TABLE, so
    // this is the only place the real migration path is exercised at all --
    // and Task 7's whole search tool rides on that index surviving.
    const dir = mkdtempSync(join(tmpdir(), "conv-migrate-"));
    const path = join(dir, "conversations.db");
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, bot TEXT NOT NULL,
      chat_id TEXT NOT NULL, message_id TEXT, source TEXT NOT NULL, user_id TEXT,
      user_name TEXT, text TEXT, attachments TEXT, reply_to TEXT, metadata TEXT
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;`);
    legacy.query("INSERT INTO messages (ts, bot, chat_id, source, text) VALUES (?,?,?,?,?)")
      .run("2026-07-01T00:00:00Z", "bot-01", "111", "user", "pesan lama");
    legacy.close();

    const db = openConversationsDb(path);

    const cols = (db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain("session_id");
    // The old row is still there, with a NULL session_id -- migration, not reset.
    const old = db.query("SELECT text, session_id FROM messages").get() as {
      text: string;
      session_id: string | null;
    };
    expect(old.text).toBe("pesan lama");
    expect(old.session_id).toBeNull();
    // And the migrated database accepts new inserts.
    insertMessage(db, { ts: "t", bot: "bot-01", chatId: "111", source: "user", text: "baru", sessionId: "s1" });
    expect(db.query("SELECT COUNT(*) AS c FROM messages").get()).toEqual({ c: 2 });
    // The pre-existing FTS index still resolves the row it indexed BEFORE the
    // ALTER, and indexes rows written after it. Without this, a migration that
    // quietly detached the index would take Task 7's search tool with it and
    // nothing would report an error.
    expect(searchMessages(db, "lama").length).toBe(1);
    expect(searchMessages(db, "baru").length).toBe(1);
    db.close();
  });

  test("message_id, reply_to and metadata round-trip through insertMessage", () => {
    const db = openConversationsDb(":memory:");
    insertMessage(db, {
      ts: "2026-07-31T00:00:00Z",
      bot: "bot-01",
      chatId: "111",
      source: "user",
      text: "halo",
      messageId: "4321",
      replyTo: "4300",
      metadata: JSON.stringify({ quote_text: "yang ini" }),
    });

    const row = db.query("SELECT message_id, reply_to, metadata FROM messages").get() as {
      message_id: string;
      reply_to: string;
      metadata: string;
    };
    expect(row.message_id).toBe("4321");
    expect(row.reply_to).toBe("4300");
    expect(JSON.parse(row.metadata)).toEqual({ quote_text: "yang ini" });
  });
});

describe("history queries", () => {
  function seed() {
    const db = openConversationsDb(":memory:");
    // Nama bot yang berbeda di SATU berkas bukan skenario buatan: sesudah state
    // per-folder, memindahkan bot = rename folder, dan kolom `bot` menyimpan
    // nama saat baris ditulis. Berkas ini tetap milik satu bot.
    const rows: Array<[string, string, string]> = [
      ["nama-lama", "100", "pesan pertama"],
      ["nama-lama", "101", "pesan kedua tentang backup"],
      ["nama-baru", "102", "pesan ketiga"],
      ["nama-baru", "103", "pesan keempat"],
      ["nama-baru", "200", "pesan kelima tentang backup"],
    ];
    for (const [bot, messageId, text] of rows) {
      insertMessage(db, { ts: "2026-07-31T00:00:00Z", bot, chatId: "111", source: "user", messageId, text });
    }
    return db;
  }

  test("returns the anchor message and the ones after it", () => {
    const found = getMessagesAround(seed(), { messageId: "101", before: 0, after: 2 });

    // "trace a few messages after the one I quoted" -- the exact request spec §9.2
    // uses as the proof that message_id is useful rather than merely stored.
    expect(found.map((m) => m.messageId)).toEqual(["101", "102", "103"]);
  });

  test("includes preceding messages when before is greater than zero, in chronological order", () => {
    const found = getMessagesAround(seed(), { messageId: "102", before: 2, after: 1 });

    expect(found.map((m) => m.messageId)).toEqual(["100", "101", "102", "103"]);
  });

  test("an unknown message id returns nothing rather than the newest messages", () => {
    // Silently falling back to "here is some history" would let the AI answer a
    // question about a message that was never found, with confident wrong data.
    expect(getMessagesAround(seed(), { messageId: "999", before: 5, after: 5 })).toEqual([]);
  });

  // Dulu test ini berbunyi "never returns another bot's messages". Asumsinya --
  // satu database memuat banyak bot -- hilang bersama keputusan per-folder.
  // Yang dijaga sekarang kebalikannya, dan bahayanya nyata: penyaring `bot`
  // yang tertinggal akan membuang riwayat DIAM-DIAM begitu foldernya di-rename.
  test("baris bernama bot lama tetap terbaca sesudah rename", () => {
    const found = getMessagesAround(seed(), { messageId: "103", before: 5, after: 0 });

    expect(found.map((m) => m.messageId)).toEqual(["100", "101", "102", "103"]);
    expect(found.some((m) => m.bot === "nama-lama")).toBe(true);
  });

  test("searchMessages honours limit dan tidak menyaring per bot", () => {
    const db = seed();

    expect(searchMessages(db, "backup").length).toBe(2);
    expect(searchMessages(db, "pesan", { limit: 2 }).length).toBe(2);
  });

  test("a malformed FTS query throws rather than corrupting results, so callers can catch it", () => {
    // Verified empirically 2026-07-31: an unbalanced double quote produces
    // SQLiteError "unterminated string". The AI supplies these keywords, so this
    // WILL happen -- main.ts turns it into an error response (see below).
    expect(() => searchMessages(seed(), 'backup"')).toThrow();
  });
});

// Penghitung giliran untuk kanal `[from: system]`. Dibaca dari database yang
// sudah ada, bukan dari penghitung baru: penghitung terpisah adalah state kedua
// yang bisa menyimpang dari kenyataan, dan menyimpangnya tidak akan terlihat.
describe("countUserTurns", () => {
  const row = (over: Record<string, unknown>) => ({
    ts: "2026-08-06T00:00:00Z",
    bot: "bot-01",
    chatId: "999",
    source: "user" as const,
    text: "halo",
    ...over,
  });

  test("menghitung hanya pesan MASUK di sesi yang diminta", () => {
    const db = openConversationsDb(":memory:");
    insertMessage(db, row({ sessionId: "S1" }));
    insertMessage(db, row({ sessionId: "S1" }));
    // Balasan bot tidak dihitung: satu pertanyaan yang dijawab tiga pesan
    // bukan tiga giliran percakapan.
    insertMessage(db, row({ sessionId: "S1", source: "assistant" }));
    // Sesi lain tidak boleh ikut terbawa.
    insertMessage(db, row({ sessionId: "S2" }));

    expect(countUserTurns(db, "S1")).toBe(2);
  });

  test("sesi yang belum punya pesan menjawab nol, bukan gagal", () => {
    const db = openConversationsDb(":memory:");
    expect(countUserTurns(db, "belum-ada")).toBe(0);
  });
});

// Pengingat mesin DISIMPAN (keputusan user 2026-08-06, mencabut keputusan
// bot-02 beberapa jam sebelumnya) tapi TIDAK ikut terbaca sebagai percakapan.
//
// Kenapa keputusan lamanya dicabut: "tidak disimpan" adalah pola AB-1, yang
// BACKLOG hukum berulang -- pesan yang tidak meninggalkan jejak tidak bisa
// DIUKUR, dan spec kanal ini sendiri menuntut satu angka ("rata-rata pengingat
// menyala per pesan") yang rancangan lamanya membuat mustahil. Data yang tidak
// dicatat tidak bisa diperbaiki belakangan; penyaringan bisa.
describe("baris source='system' tercatat tapi tidak muncul sebagai percakapan", () => {
  const seed = (db: ReturnType<typeof openConversationsDb>) => {
    insertMessage(db, {
      ts: "2026-08-06T00:00:00Z",
      bot: "bot-01",
      chatId: "999",
      messageId: "10",
      source: "user",
      text: "halo dunia",
    });
    insertMessage(db, {
      ts: "2026-08-06T00:00:01Z",
      bot: "bot-01",
      chatId: "999",
      source: "system",
      text: "segera beri nama session ini",
    });
  };

  test("tersimpan, sehingga bisa dihitung nanti", () => {
    const db = openConversationsDb(":memory:");
    seed(db);

    const row = db.query("SELECT COUNT(*) AS n FROM messages WHERE source = 'system'").get() as {
      n: number;
    };
    expect(row.n).toBe(1);
  });

  test("tidak ikut terbawa saat AI membaca riwayat di sekitar sebuah pesan", () => {
    const db = openConversationsDb(":memory:");
    seed(db);

    const around = getMessagesAround(db, { messageId: "10", before: 5, after: 5 });
    expect(around.some((m) => m.source === "system")).toBe(false);
  });

  test("tidak ikut muncul saat AI mencari riwayat", () => {
    const db = openConversationsDb(":memory:");
    seed(db);

    expect(searchMessages(db, "session").length).toBe(0);
    expect(searchMessages(db, "halo").length).toBe(1);
  });

  // Giliran dihitung dari pesan user; pengingat tidak boleh ikut menggeser
  // angkanya, karena itu akan membuat pengingat memicu dirinya sendiri lebih
  // cepat pada tiap sesi.
  test("tidak ikut terhitung sebagai giliran user", () => {
    const db = openConversationsDb(":memory:");
    insertMessage(db, {
      ts: "2026-08-06T00:00:00Z",
      bot: "bot-01",
      chatId: "999",
      source: "system",
      text: "pengingat",
      sessionId: "S1",
    });

    expect(countUserTurns(db, "S1")).toBe(0);
  });
});
