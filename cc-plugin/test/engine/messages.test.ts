import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliverIncoming,
  normalizeMessage,
  buildAlbumMessage,
  buildTappedMessageEdit,
  findMissingButtonNarration,
  findUnsafeButtonData,
  handleHistoryRequest,
  handleSearchRequest,
} from "../../src/engine/messages";
import { insertMessage } from "../../src/engine/db/conversations-schema";
import { openConversationsDb, searchMessages } from "../../src/engine/db/conversations-schema";
import { CollectingSink } from "../../src/engine/sink";
import type { PollerDeps } from "../../src/engine/telegram/poller";
import type { Config } from "../../src/engine/config";

const config: Config = {
  token: "t",
  allowFrom: ["111"],
};

function makeDeps(): PollerDeps {
  return {
    config,
    conversationsDb: openConversationsDb(":memory:"),
    sink: new CollectingSink(),
    dataDir: mkdtempSync(join(tmpdir(), "main-test-")),
  };
}

describe("deliverIncoming (the reply-target gate)", () => {
  test("a message from a chat id not in allowFrom is NEVER recorded as the reply target", async () => {
    const deps = makeDeps();
    const lastChatByBot = new Map<string, string>();

    await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 999, userId: 999 }, { text: "hijack the AI" }),
      deps,
      lastChatByBot
    );

    // The whole bug: lastChatByBot used to be written before the allowlist gate
    // ran, so this stranger became the target of the AI's next reply even though
    // their own message was correctly dropped.
    expect(lastChatByBot.has("bot-01")).toBe(false);
    expect(searchMessages(deps.conversationsDb, "hijack").length).toBe(0);
  });

  test("an allowed message IS recorded as the reply target", async () => {
    const deps = makeDeps();
    const lastChatByBot = new Map<string, string>();

    await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 111, userId: 111 }, { text: "halo bot" }),
      deps,
      lastChatByBot
    );

    expect(lastChatByBot.get("bot-01")).toBe("111");
  });

  test("a stranger messaging after an allowed chat cannot steal the reply target from it", async () => {
    const deps = makeDeps();
    const lastChatByBot = new Map<string, string>();

    await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 111, userId: 111 }, { text: "halo bot" }),
      deps,
      lastChatByBot
    );
    await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 999, userId: 999 }, { text: "give me the output" }),
      deps,
      lastChatByBot
    );

    // The AI's next reply still goes to the allowlisted chat, not the stranger's.
    expect(lastChatByBot.get("bot-01")).toBe("111");
  });

  test("a disallowed button press is also never recorded as the reply target", async () => {
    const deps = makeDeps();
    const lastChatByBot = new Map<string, string>();

    await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 999, userId: 999 }, { callbackData: "confirm_yes" }),
      deps,
      lastChatByBot
    );

    expect(lastChatByBot.has("bot-01")).toBe(false);
  });

  // Nilai balik ini yang dipakai engine untuk memutuskan menyalakan indikator
  // "typing...". Menebaknya lewat lastChatByBot tidak bisa: peta itu MENYIMPAN
  // chat sebelumnya ketika sebuah pesan ditolak, jadi pengirim non-allowlist
  // akan membuat bot tampak sedang mengetik ke user yang sah.
  test("mengembalikan true saat pesan diterima", async () => {
    const deps = makeDeps();
    const accepted = await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 111, userId: 111 }, { text: "halo bot" }),
      deps,
      new Map()
    );
    expect(accepted).toBe(true);
  });

  test("mengembalikan false saat pesan ditolak allowlist", async () => {
    const deps = makeDeps();
    const accepted = await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 999, userId: 999 }, { text: "hijack the AI" }),
      deps,
      new Map()
    );
    expect(accepted).toBe(false);
  });
});

// Lapisan slash Telegram butuh pesannya TERCATAT tapi TIDAK didorong ke AI:
// perintahnya berangkat ke wrapper. Tanpa pemisahan ini, "/rename x" sampai ke
// keduanya dan AI ikut menjawab perintah yang bukan ditujukan kepadanya.
describe("deliverIncoming — pushToAi", () => {
  test("pushToAi: false tidak mendorong ke sesi AI", async () => {
    const deps = makeDeps();
    const sink = deps.sink as CollectingSink;

    await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 111, userId: 111 }, { text: "/rename sesi-x" }),
      deps,
      new Map(),
      { pushToAi: false }
    );

    expect(sink.sent).toHaveLength(0);
  });

  // Meteran kedua, dan yang ini yang menjaga aturan spec §2.3: sink kosong saja
  // tidak membuktikan apa pun -- ia sama-sama kosong kalau pesannya dibuang
  // seluruhnya. Yang membedakan "dicegat" dari "hilang" adalah barisnya ADA di
  // db. Sistem lama gagal persis di sini, dan biayanya audit yang membaca
  // /switch sebagai 0x dipakai padahal 139x.
  test("pushToAi: false TETAP mencatat barisnya ke conversations.db", async () => {
    const deps = makeDeps();

    await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 111, userId: 111 }, { text: "/rename sesi-x" }),
      deps,
      new Map(),
      { pushToAi: false }
    );

    expect(searchMessages(deps.conversationsDb, "rename").length).toBe(1);
  });

  test("tanpa opsi, pesan biasa tetap didorong ke AI seperti sebelumnya", async () => {
    const deps = makeDeps();
    const sink = deps.sink as CollectingSink;

    await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 111, userId: 111 }, { text: "halo bot" }),
      deps,
      new Map()
    );

    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]!.text).toBe("halo bot");
  });

  test("pesan yang ditolak allowlist tidak tercatat, apa pun nilai pushToAi", async () => {
    const deps = makeDeps();

    await deliverIncoming(
      normalizeMessage("bot-01", { chatId: 999, userId: 999 }, { text: "/rename curian" }),
      deps,
      new Map(),
      { pushToAi: false }
    );

    expect(searchMessages(deps.conversationsDb, "curian").length).toBe(0);
  });
});

describe("normalizeMessage", () => {
  test("derives the same identity fields regardless of payload kind", () => {
    const ids = { chatId: 111, userId: 222, userName: "mirza", dateSeconds: 1_800_000_000 };

    const text = normalizeMessage("bot-01", ids, { text: "halo" });
    const photo = normalizeMessage("bot-01", ids, { photoUrls: ["http://x/1.jpg"] });
    const callback = normalizeMessage("bot-01", ids, { callbackData: "confirm_yes" });

    for (const msg of [text, photo, callback]) {
      expect(msg.bot).toBe("bot-01");
      // Telegram sends numeric ids; every consumer downstream expects strings.
      expect(msg.chatId).toBe("111");
      expect(msg.userId).toBe("222");
      expect(msg.userName).toBe("mirza");
      expect(msg.ts).toBe(new Date(1_800_000_000 * 1000).toISOString());
    }

    expect(text.text).toBe("halo");
    expect(photo.photoUrls).toEqual(["http://x/1.jpg"]);
    expect(callback.callbackData).toBe("confirm_yes");
  });

  test("falls back to the chat id as user id and to now as the timestamp", () => {
    const before = Date.now();
    const msg = normalizeMessage("bot-01", { chatId: 111, userId: 111 }, { text: "halo" });

    expect(msg.userId).toBe("111");
    expect(msg.userName).toBeUndefined();
    // No `date` from Telegram (callback queries carry none) -- stamped with now.
    expect(new Date(msg.ts).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(msg.ts).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("carries the Telegram message id through as a string", () => {
    const msg = normalizeMessage(
      "bot-01",
      { chatId: 111, userId: 111, messageId: 4321 },
      { text: "halo" }
    );

    // Telegram sends it as a number; the column and every consumer downstream
    // (meta values, history lookups) are strings.
    expect(msg.messageId).toBe("4321");
  });

  test("leaves the message id undefined when the handler has none, without inventing one", () => {
    const msg = normalizeMessage("bot-01", { chatId: 111, userId: 111 }, { callbackData: "confirm_yes" });

    // A button press has no message of its own. Storing the bot's message id
    // here would make history navigation point at the wrong row.
    expect(msg.messageId).toBeUndefined();
  });
});

describe("buildAlbumMessage", () => {
  const item = (messageId: number, url: string, caption?: string) => ({
    messageId,
    chatId: 111,
    userId: 111,
    userName: "mirza",
    dateSeconds: 1_800_000_000,
    url,
    caption,
  });

  test("orders album members by message_id ASC regardless of the order they arrived in", () => {
    const msg = buildAlbumMessage("bot-01", [
      item(103, "http://x/c.jpg"),
      item(101, "http://x/a.jpg"),
      item(102, "http://x/b.jpg"),
    ]);

    // SCAR-055a: photos arrive out of order under load, and the buffer keeps
    // arrival order. Labelling "Photo 1" against the wrong file is worse than
    // no labels at all.
    expect(msg.photoUrls).toEqual(["http://x/a.jpg", "http://x/b.jpg", "http://x/c.jpg"]);
    expect(msg.messageIds).toEqual(["101", "102", "103"]);
    // The album's own id is the first member's -- that is the id Telegram shows
    // the user when they quote the album.
    expect(msg.messageId).toBe("101");
    expect(msg.isAlbum).toBe(true);
  });

  test("no caption anywhere leaves the text empty rather than inventing one", () => {
    const msg = buildAlbumMessage("bot-01", [item(101, "http://x/a.jpg"), item(102, "http://x/b.jpg")]);

    expect(msg.text).toBeUndefined();
  });

  test("exactly one caption becomes the message text, verbatim and unlabelled", () => {
    const msg = buildAlbumMessage("bot-01", [
      item(101, "http://x/a.jpg"),
      item(102, "http://x/b.jpg", "ini foto kedua yang penting"),
    ]);

    // One caption is just the user talking about the album. Labelling it
    // "Photo 2:" would add noise to the overwhelmingly common case.
    expect(msg.text).toBe("ini foto kedua yang penting");
  });

  test("two or more captions are labelled Photo <n> in album order", () => {
    const msg = buildAlbumMessage("bot-01", [
      item(103, "http://x/c.jpg", "yang ketiga"),
      item(101, "http://x/a.jpg", "yang pertama"),
      item(102, "http://x/b.jpg"),
    ]);

    // Numbering follows the SORTED position, not the arrival position -- the
    // whole reason ordering had to be fixed first.
    expect(msg.text).toBe("Photo 1: yang pertama\nPhoto 3: yang ketiga");
  });

  test("the identity fields come from the first member, not from whichever arrived first", () => {
    const msg = buildAlbumMessage("bot-01", [item(103, "http://x/c.jpg"), item(101, "http://x/a.jpg")]);

    expect(msg.bot).toBe("bot-01");
    expect(msg.chatId).toBe("111");
    expect(msg.userId).toBe("111");
    expect(msg.userName).toBe("mirza");
    expect(msg.ts).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });
});

describe("buildTappedMessageEdit (U-2: a tapped keyboard must not stay tappable)", () => {
  test("appends the chosen option to the end of the original text", () => {
    const edit = buildTappedMessageEdit({ text: "Pilih salah satu:" }, "confirm_yes");

    // The prompt itself has to survive: the chat history is the only record of
    // what the question was once the buttons are gone.
    expect(edit).toEqual({ text: "Pilih salah satu:\n\n→ confirm_yes" });
  });

  test("carries the original entities through, so formatting survives the edit", () => {
    // `as const` pada type: MessageEntity grammy adalah union yang disempitkan
    // oleh field itu, dan `string` polos cocok dengan tidak satu pun anggotanya.
    const entities = [{ type: "bold" as const, offset: 0, length: 5 }];
    const edit = buildTappedMessageEdit({ text: "Pilih salah satu:", entities }, "confirm_no");

    // editMessageText treats the new text as plain, so an edit without entities
    // silently strips every bold/italic/code run the original had. Appending at
    // the END is what keeps the existing offsets pointing at the same characters.
    expect(edit?.entities).toEqual(entities);
    expect(edit?.text.startsWith("Pilih salah satu:")).toBe(true);
  });

  test("sends no entities key at all when the original had none", () => {
    const edit = buildTappedMessageEdit({ text: "Pilih:", entities: [] }, "a");

    // Also pins the mechanism that actually removes the keyboard: the payload
    // carries no reply_markup, and Telegram drops the markup of any message
    // edited without one.
    expect(Object.keys(edit!)).toEqual(["text"]);
  });

  test("declines to edit a message that has no text of its own", () => {
    // A caption-only message (photo with buttons) or one Telegram reports as
    // inaccessible. editMessageText would fail on both; the press still counts.
    expect(buildTappedMessageEdit({}, "confirm_yes")).toBeNull();
    expect(buildTappedMessageEdit(undefined, "confirm_yes")).toBeNull();
  });
});

describe("findMissingButtonNarration (U-5: numbered buttons must be explained in the body)", () => {
  const row = (...labels: string[]) => [labels.map((text) => ({ text, data: `d_${text}` }))];

  test("numeric buttons with a matching numbered list are allowed", () => {
    expect(
      findMissingButtonNarration("Pilih:\n1. Lanjut backup\n2. Batalkan", row("1", "2"))
    ).toBeNull();
  });

  test("numeric buttons with no numbered list at all are rejected", () => {
    // The exact message the user kept receiving: two bare numbers on screen and
    // nothing anywhere saying what they mean.
    expect(findMissingButtonNarration("Pilih salah satu:", row("1", "2"))).not.toBeNull();
  });

  test("explaining only one of the numbers is still rejected, and the error names the missing one", () => {
    const error = findMissingButtonNarration("Pilih:\n1. Lanjut backup", row("1", "2"));

    // Half a legend is as unusable on a phone as none: "2" is still a mystery.
    expect(error).not.toBeNull();
    expect(error).toContain("2");
  });

  test("the paren style 1) 2) counts as a numbered list too", () => {
    expect(
      findMissingButtonNarration("Pilih:\n1) Lanjut backup\n2) Batalkan", row("1", "2"))
    ).toBeNull();
  });

  test("an indented numbered line still counts", () => {
    // Nested under a heading or a bullet is ordinary formatting, not a violation.
    expect(
      findMissingButtonNarration("Opsi:\n   1. Lanjut backup\n\t2. Batalkan", row("1", "2"))
    ).toBeNull();
  });

  test("the escape-hatch button does not have to be numbered", () => {
    // "✏️ Explain manually" is the convention's own required last button. Counting
    // it would make every correctly-formed prompt unsendable.
    expect(
      findMissingButtonNarration(
        "Pilih:\n1. Lanjut backup\n2. Batalkan",
        row("1", "2", "✏️ Explain manually")
      )
    ).toBeNull();
  });

  test("descriptive labels never trigger the rule, list or no list", () => {
    // The rule exists to make numbers meaningful, not to force numbering on
    // labels that already say what they do.
    expect(findMissingButtonNarration("Jadi lanjut?", row("✅ Ya", "❌ Tidak"))).toBeNull();
  });

  test("a single numeric button is below the threshold and is allowed", () => {
    // One number is not enough signal: it may well be a quantity ("1" hour), and
    // rejecting on a guess would block sends the convention never meant to cover.
    expect(findMissingButtonNarration("Berapa jam?", row("1"))).toBeNull();
  });

  test("a reply with no buttons is never affected", () => {
    expect(findMissingButtonNarration("1 dan 2 tanpa tombol")).toBeNull();
    expect(findMissingButtonNarration("teks biasa", [])).toBeNull();
  });

  test("numeric labels split across separate rows are still counted together", () => {
    // Row layout is cosmetic; the user sees one keyboard either way.
    expect(
      findMissingButtonNarration("Pilih salah satu:", [
        [{ text: "1", data: "a" }],
        [{ text: "2", data: "b" }],
      ])
    ).not.toBeNull();
  });

  test("a number mentioned mid-sentence does not count as explaining it", () => {
    // "option 2 is safer" is prose, not a legend line -- the phone still shows a
    // bare button with no line to read it against.
    expect(
      findMissingButtonNarration("1. Lanjut backup, though option 2 is safer", row("1", "2"))
    ).not.toBeNull();
  });

  test("the error tells the AI both ways to fix it rather than only saying no", () => {
    const error = findMissingButtonNarration("Pilih salah satu:", row("1", "2"))!;

    // A refusal that does not teach the correct alternative is a rule the AI
    // cannot comply with -- it just retries the same thing.
    expect(error).toContain("1.");
    expect(error.toLowerCase()).toContain("descriptive");
  });
});

describe("history and search (satu database per bot)", () => {
  function seeded() {
    const db = openConversationsDb(":memory:");
    // Dua nama bot berbeda di SATU berkas: itu persis yang terjadi sesudah
    // sebuah folder di-rename, karena kolom `bot` menyimpan nama saat baris
    // ditulis. Sesudah state per-folder, berkas ini milik satu bot, jadi
    // KEDUANYA harus terbaca.
    insertMessage(db, { ts: "t", bot: "nama-lama", chatId: "111", source: "user", messageId: "100", text: "sebelum rename, soal backup" });
    insertMessage(db, { ts: "t", bot: "nama-lama", chatId: "111", source: "user", messageId: "101", text: "lanjutannya" });
    insertMessage(db, { ts: "t", bot: "nama-baru", chatId: "111", source: "user", messageId: "102", text: "sesudah rename, soal backup" });
    return db;
  }

  test("history membaca seluruh isi database ini, apa pun nilai kolom bot-nya", () => {
    const res = handleHistoryRequest({ messageId: "101", before: 5, after: 5 }, seeded());

    expect(res).toMatchObject({ ok: true });
    const messages = (res as { ok: true; messages: any[] }).messages;
    expect(messages.map((m) => m.messageId)).toEqual(["100", "101", "102"]);
  });

  // Dulu ada test yang mengunci "menyeberang ke bot lain HANYA kalau parameter
  // bot disebut" (K-3), lalu satu lagi yang mengunci KETIADAAN jalur itu.
  // Keduanya berdiri di atas asumsi yang sekarang tidak ada: satu database
  // memuat banyak bot. Yang dikunci sekarang adalah bahayanya yang sebenarnya --
  // penyaring `bot` yang tertinggal akan membuang riwayat diam-diam begitu
  // folder di-rename, dan rename adalah cara resmi memindahkan bot.
  test("rename folder tidak membuang riwayat lama", () => {
    const res = handleSearchRequest({ query: "backup" }, seeded());

    const messages = (res as { ok: true; messages: any[] }).messages;
    expect(messages.length).toBe(2);
  });

  test("a malformed FTS query is answered with an error instead of throwing out of the handler", () => {
    // Verified: an unbalanced quote makes SQLite throw. The AI writes these
    // queries, so this is a normal input, not an exotic one. Throwing here would
    // reach the tool layer's catch-all -- answerable, but useless to the AI,
    // which cannot tell it should just rephrase.
    const res = handleSearchRequest({ query: 'backup"' }, seeded());

    expect(res).toMatchObject({ ok: false });
    expect((res as { ok: false; error: string }).error).toContain("bad_search_query");
  });
});

describe("findUnsafeButtonData (apa yang Telegram dan lapisan slash tidak terima)", () => {
  const btn = (data: string) => [[{ text: "Ya", data }]];

  test("callback_data biasa dilewatkan", () => {
    expect(findUnsafeButtonData(btn("confirm_yes"))).toBeNull();
  });

  test("64 byte masih sah -- batasnya inklusif", () => {
    expect(findUnsafeButtonData(btn("x".repeat(64)))).toBeNull();
  });

  test("65 byte ditolak, dan errornya menyebut labelnya", () => {
    // Telegram menjawab 400 BUTTON_DATA_INVALID. Kalau baru ketahuan di sana,
    // potongan-potongan teks sebelumnya SUDAH mendarat di HP user.
    const error = findUnsafeButtonData(btn("x".repeat(65)));
    expect(error).not.toBeNull();
    expect(error).toContain("Ya");
    expect(error).toContain("64");
  });

  test("dihitung per BYTE, bukan per karakter", () => {
    // 17 emoji 4-byte = 68 byte tapi hanya 34 unit UTF-16 dan 17 code point.
    // Menghitung panjang string akan meloloskan yang Telegram tolak.
    const emoji = "😀".repeat(17);
    expect(emoji.length).toBeLessThan(65);
    expect(findUnsafeButtonData(btn(emoji))).not.toBeNull();
  });

  test("prefiks `slash:` ditolak -- namespace itu milik lapisan slash", () => {
    // Tanpa pagar ini, tap-nya TIDAK sampai ke AI dan langsung ditulis ke
    // slash/, jadi cc-wrapper mengetikkannya ke Claude Code tanpa satu pun
    // prompt konfirmasi -- justru langkah yang dilewatinya.
    const error = findUnsafeButtonData(btn("slash:go:/clear"));
    expect(error).not.toBeNull();
    expect(error).toContain("slash:");
  });

  test("prefiks `slash:` ditolak apa pun sisanya, termasuk yang tidak dikenal", () => {
    expect(findUnsafeButtonData(btn("slash:apa-saja"))).not.toBeNull();
  });

  test("kata `slash` yang bukan prefiks tidak kena", () => {
    // Yang dijaga adalah namespace-nya, bukan kata-katanya.
    expect(findUnsafeButtonData(btn("backslash:x"))).toBeNull();
    expect(findUnsafeButtonData(btn("slashdot"))).toBeNull();
  });

  test("seluruh baris diperiksa, bukan cuma yang pertama", () => {
    expect(
      findUnsafeButtonData([
        [{ text: "Aman", data: "ok" }],
        [{ text: "Bahaya", data: "slash:go:/clear" }],
      ])
    ).not.toBeNull();
  });

  test("balasan tanpa tombol tidak pernah kena", () => {
    expect(findUnsafeButtonData()).toBeNull();
    expect(findUnsafeButtonData([])).toBeNull();
  });
});
