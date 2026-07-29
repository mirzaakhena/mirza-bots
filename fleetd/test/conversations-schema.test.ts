import { describe, test, expect } from "bun:test";
import { openConversationsDb, insertMessage, searchMessages } from "../src/db/conversations-schema";

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
