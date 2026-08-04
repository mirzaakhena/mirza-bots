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

  const hits = searchMessages(db, "xyzzy");
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

test("baris lampiran menyimpan path di kolom attachments dan kind di metadata", () => {
  const db = openConversationsDb(":memory:");

  storeOutgoing(db, {
    bot: "bot-uji",
    chatId: "111",
    messageId: "700",
    attachments: ["C:/x/a.png"],
    kind: "photo",
    sessionId: "sess-9",
  });

  const row = db
    .query("SELECT source, message_id, text, attachments, metadata, session_id FROM messages")
    .get() as any;
  expect(row.source).toBe("assistant");
  expect(row.message_id).toBe("700");
  // Teksnya sudah jadi barisnya sendiri; baris berkas tidak menduplikasinya.
  expect(row.text).toBeNull();
  expect(JSON.parse(row.attachments)).toEqual(["C:/x/a.png"]);
  expect(JSON.parse(row.metadata)).toEqual({ kind: "photo" });
  expect(row.session_id).toBe("sess-9");
});

// Kutipan hanya di pesan pertama -- aturan yang sudah berlaku untuk chunking,
// dan berkas bukan pesan pertama. 0 dari 110 kiriman historis pernah memakainya.
test("baris lampiran tidak membawa kutipan", () => {
  const db = openConversationsDb(":memory:");
  storeOutgoing(db, {
    bot: "bot-uji",
    chatId: "111",
    messageId: "703",
    attachments: ["C:/x/a.png"],
    kind: "photo",
  });

  const row = db.query("SELECT reply_to FROM messages").get() as any;
  expect(row.reply_to).toBeNull();
});

test("dokumen tercatat dengan kind document", () => {
  const db = openConversationsDb(":memory:");
  storeOutgoing(db, {
    bot: "bot-uji",
    chatId: "111",
    messageId: "701",
    attachments: ["C:/x/a.pdf"],
    kind: "document",
  });

  const row = db.query("SELECT metadata FROM messages").get() as any;
  expect(JSON.parse(row.metadata)).toEqual({ kind: "document" });
});

// Kolom yang berisi string "{}" akan memaksa setiap pembaca nanti
// memperlakukannya sebagai kasus khusus "ada tapi kosong".
test("balasan teks biasa tidak menulis apa pun ke attachments maupun metadata", () => {
  const db = openConversationsDb(":memory:");
  storeOutgoing(db, { bot: "bot-uji", chatId: "111", messageId: "702", text: "halo" });

  const row = db.query("SELECT attachments, metadata FROM messages").get() as any;
  expect(row.attachments).toBeNull();
  expect(row.metadata).toBeNull();
});

import { planSendOptionsFor } from "../../src/engine/engine";

// Keyboard di potongan tengah menggantung di atas teks lanjutan.
test("tombol hanya menempel di potongan terakhir", () => {
  const kb = { inline_keyboard: [] } as any;
  expect(planSendOptionsFor(0, 3, kb, undefined)?.reply_markup).toBeUndefined();
  expect(planSendOptionsFor(1, 3, kb, undefined)?.reply_markup).toBeUndefined();
  expect(planSendOptionsFor(2, 3, kb, undefined)?.reply_markup).toBeDefined();
});

// Yang dijawab adalah balasannya secara keseluruhan, bukan potongan ke-3.
test("kutipan hanya menempel di potongan pertama", () => {
  expect(planSendOptionsFor(0, 3, undefined, "89")?.reply_parameters).toEqual({ message_id: 89 });
  expect(planSendOptionsFor(1, 3, undefined, "89")).toBeUndefined();
  expect(planSendOptionsFor(2, 3, undefined, "89")).toBeUndefined();
});

test("satu potongan membawa keduanya sekaligus", () => {
  const opts = planSendOptionsFor(0, 1, { inline_keyboard: [] } as any, "89");
  expect(opts?.reply_markup).toBeDefined();
  expect(opts?.reply_parameters).toEqual({ message_id: 89 });
});
