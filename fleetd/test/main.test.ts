import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliverIncoming,
  normalizeMessage,
  buildAlbumMessage,
  buildTappedMessageEdit,
  handleHistoryRequest,
  handleSearchRequest,
} from "../src/main";
import { insertMessage } from "../src/db/conversations-schema";
import type { BoundConnection } from "../src/socket/registry";
import { openConversationsDb, searchMessages } from "../src/db/conversations-schema";
import { openFleetDb } from "../src/db/fleet-schema";
import { ConnectionRegistry } from "../src/socket/registry";
import type { PollerDeps } from "../src/telegram/poller";
import type { Config } from "../src/config";

const config: Config = {
  allowFrom: ["111"],
  bots: { "bot-01": { home: "/tmp/bot-01", token: "t" } },
};

function makeDeps(): PollerDeps {
  return {
    config,
    conversationsDb: openConversationsDb(":memory:"),
    fleetDb: openFleetDb(":memory:"),
    registry: new ConnectionRegistry(),
    inboxRoot: mkdtempSync(join(tmpdir(), "main-test-")),
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
    const entities = [{ type: "bold", offset: 0, length: 5 }];
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

describe("history and search socket handlers (K-3: default to the caller's own bot)", () => {
  function seeded() {
    const db = openConversationsDb(":memory:");
    insertMessage(db, { ts: "t", bot: "bot-01", chatId: "111", source: "user", messageId: "100", text: "punya bot-01 tentang backup" });
    insertMessage(db, { ts: "t", bot: "bot-01", chatId: "111", source: "user", messageId: "101", text: "lanjutan bot-01" });
    insertMessage(db, { ts: "t", bot: "bot-02", chatId: "222", source: "user", messageId: "100", text: "punya bot-02 tentang backup" });
    return db;
  }
  const twoBots: Config = {
    allowFrom: ["111"],
    bots: { "bot-01": { home: "/tmp/bot-01", token: "t" }, "bot-02": { home: "/tmp/bot-02", token: "t" } },
  };
  const conn = (boundBot: string | null): BoundConnection => ({ send: () => {}, boundBot });

  test("history defaults to the calling bot and never leaks another bot's messages", () => {
    const res = handleHistoryRequest({ type: "history", messageId: "100" }, conn("bot-01"), twoBots, seeded());

    // bot-02 also has a message_id 100. Defaulting wrong here would hand one
    // bot's private conversation to another bot's AI with no one asking for it.
    expect(res).toMatchObject({ ok: true });
    const messages = (res as { ok: true; messages: any[] }).messages;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.bot === "bot-01")).toBe(true);
    expect(messages.some((m) => m.text.includes("bot-02"))).toBe(false);
  });

  test("history crosses to another bot only when the bot parameter is given explicitly", () => {
    const res = handleHistoryRequest(
      { type: "history", messageId: "100", bot: "bot-02" },
      conn("bot-01"),
      twoBots,
      seeded()
    );

    const messages = (res as { ok: true; messages: any[] }).messages;
    expect(messages.every((m) => m.bot === "bot-02")).toBe(true);
  });

  test("search defaults to the calling bot and never leaks another bot's messages", () => {
    const res = handleSearchRequest({ type: "search", query: "backup" }, conn("bot-01"), twoBots, seeded());

    const messages = (res as { ok: true; messages: any[] }).messages;
    // Both bots have a message containing "backup"; only one is the caller's.
    expect(messages.length).toBe(1);
    expect(messages[0].bot).toBe("bot-01");
  });

  test("a connection that never said hello cannot read any history at all", () => {
    expect(handleHistoryRequest({ type: "history", messageId: "100" }, conn(null), twoBots, seeded()))
      .toEqual({ ok: false, error: "not_identified" });
    expect(handleSearchRequest({ type: "search", query: "backup" }, conn(null), twoBots, seeded()))
      .toEqual({ ok: false, error: "not_identified" });
  });

  test("naming a bot that is not in the config is rejected rather than silently returning nothing", () => {
    expect(
      handleSearchRequest({ type: "search", query: "backup", bot: "bot-99" }, conn("bot-01"), twoBots, seeded())
    ).toEqual({ ok: false, error: "unknown_bot" });
  });

  test("a malformed FTS query is answered with an error instead of throwing out of the handler", () => {
    // Verified: an unbalanced quote makes SQLite throw. The AI writes these
    // queries, so this is a normal input, not an exotic one. Throwing here would
    // reach the socket server's catch-all as handler_failed -- answerable, but
    // useless to the AI, which cannot tell it should just rephrase.
    const res = handleSearchRequest({ type: "search", query: 'backup"' }, conn("bot-01"), twoBots, seeded());

    expect(res).toMatchObject({ ok: false });
    expect((res as { ok: false; error: string }).error).toContain("bad_search_query");
  });
});
