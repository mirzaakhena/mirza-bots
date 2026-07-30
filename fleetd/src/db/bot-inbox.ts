import type { Database } from "bun:sqlite";
import type { PushMessage } from "../socket/protocol";

export function queueMessage(db: Database, bot: string, payload: PushMessage): void {
  db.query(
    `INSERT INTO bot_inbox (bot, kind, payload, delivered, created_at) VALUES (?, ?, ?, 0, ?)`
  ).run(bot, "telegram_message", JSON.stringify(payload), new Date().toISOString());
}

export function drainQueue(db: Database, bot: string): PushMessage[] {
  const rows = db
    .query(
      `SELECT id, payload FROM bot_inbox WHERE bot = ? AND delivered = 0 ORDER BY id ASC`
    )
    .all(bot) as Array<{ id: number; payload: string }>;

  if (rows.length === 0) return [];

  const now = new Date().toISOString();
  const markDelivered = db.query(`UPDATE bot_inbox SET delivered = 1, delivered_at = ? WHERE id = ?`);
  for (const row of rows) markDelivered.run(now, row.id);

  return rows.map((row) => JSON.parse(row.payload) as PushMessage);
}
