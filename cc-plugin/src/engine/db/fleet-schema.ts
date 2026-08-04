import { Database } from "bun:sqlite";

/**
 * Skema `fleet.db` — state operasional yang boleh hilang.
 *
 * Sengaja HANYA memuat tabel yang benar-benar ada kodenya. Empat tabel lain
 * (`sessions`, `handoffs`, `injections`, `incidents`) dibuang 2026-08-04
 * setelah diukur: masing-masing **nol baris di produksi DAN nol rujukan di
 * seluruh `src/`** — 77 baris skema untuk satu tabel yang hidup. Semuanya
 * ditulis saat masih ada daemon dan rencana yang lebih besar, lalu bertahan
 * karena tidak ada yang error.
 *
 * Ongkosnya bukan ruang penyimpanan, melainkan penyunting berikutnya yang harus
 * membaca dan bertanya "ini dipakai buat apa?" — dan pembaca dokumen yang
 * mengira fiturnya ada padahal baru mejanya.
 *
 * Aturannya sekarang: **jangan buat tabel sampai ada kode yang mengisinya di
 * commit yang sama.** Kalau protokol handoff dibangun nanti, `handoffs` lahir
 * bersama kodenya — bukan menunggu bertahun-tahun sebagai meja kosong.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
`;

export const FLEET_TABLES = ["bot_inbox"] as const;

export function openFleetDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  // WAL already lets readers and writers run in parallel, but two writers
  // still serialise. Up to six sessions now open this file instead of one
  // daemon, so the loser of a write race must WAIT rather than fail --
  // SQLITE_BUSY surfaces as a random, hard-to-trace error at the call site.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}
