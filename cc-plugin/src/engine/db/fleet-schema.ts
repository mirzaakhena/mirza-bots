import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  source TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_bot TEXT NOT NULL,
  to_bot TEXT NOT NULL,
  slug TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'terkirim',
  mode TEXT NOT NULL DEFAULT 'handoff',
  deadline_at TEXT,
  paired_with INTEGER REFERENCES handoffs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS injections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot TEXT NOT NULL,
  command_class TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'antre',
  attempt INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  written_at TEXT,
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS bot_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  detail TEXT,
  bot TEXT,
  occurred_at TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT
);
`;

export const FLEET_TABLES = ["sessions", "handoffs", "injections", "bot_inbox", "incidents"] as const;

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
