import { expect, test } from "bun:test";
import { openConversationsDb, searchMessages } from "../../src/engine/db/conversations-schema";
import { storeOutgoing, buildSendOptions } from "../../src/engine/engine";

test("stores the reply with source=assistant and the id Telegram gave back", () => {
  const db = openConversationsDb(":memory:");

  storeOutgoing(db, {
    bot: "bot-uji",
    chatId: "111",
    messageId: "512",
    text: "halo balik",
    sessionId: "sess-1",
  });

  const row = db.query("SELECT source, message_id, text, session_id FROM messages").get() as any;
  expect(row.source).toBe("assistant");
  expect(row.message_id).toBe("512");
  expect(row.text).toBe("halo balik");
  expect(row.session_id).toBe("sess-1");
});

// The whole point of storing them: history stops being one-sided. Before this,
// the AI could re-read what the user said but never what it answered -- which
// matters most exactly when its context was cleared.
test("a stored reply is findable by search, so history is no longer one-sided", () => {
  const db = openConversationsDb(":memory:");
  storeOutgoing(db, { bot: "bot-uji", chatId: "111", messageId: "512", text: "jawaban unik xyzzy" });

  const hits = searchMessages(db, "xyzzy", { bot: "bot-uji" });
  expect(hits.length).toBe(1);
  expect(hits[0]!.source).toBe("assistant");
});

test("an unknown session id is stored as absent, never as the word undefined", () => {
  const db = openConversationsDb(":memory:");
  storeOutgoing(db, { bot: "bot-uji", chatId: "111", messageId: "9", text: "x" });

  const row = db.query("SELECT session_id FROM messages").get() as any;
  expect(row.session_id).toBeNull();
});

test("a quoted reply records which message it answered", () => {
  const db = openConversationsDb(":memory:");
  storeOutgoing(db, { bot: "bot-uji", chatId: "111", messageId: "9", text: "x", replyTo: "89" });

  const row = db.query("SELECT reply_to FROM messages").get() as any;
  expect(row.reply_to).toBe("89");
});

test("passes the quoted message id through to Telegram", () => {
  expect(buildSendOptions(undefined, "89")).toEqual({ reply_parameters: { message_id: 89 } });
});

// grammy forwards this object as-is, and a present-but-empty reply_parameters is
// a 400 from Telegram. Absent must mean absent.
test("no quote and no buttons means no options object at all", () => {
  expect(buildSendOptions(undefined, undefined)).toBeUndefined();
});

test("a quote and buttons travel together", () => {
  const opts = buildSendOptions({ inline_keyboard: [] } as any, "89");
  expect(opts?.reply_parameters).toEqual({ message_id: 89 });
  expect(opts?.reply_markup).toBeDefined();
});

// Telegram answers a non-numeric id with an opaque 400. Refuse it here, where
// the message can name both the cause and the fix -- and where U-3 can be
// repeated: the AI must never ask the user for an id.
test("a non-numeric quote id is refused before anything is sent", () => {
  let message = "";
  try {
    buildSendOptions(undefined, "bukan-angka");
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("reply_to");
  expect(message).toContain("never ask the user");
});
