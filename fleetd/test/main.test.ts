import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverIncoming, normalizeMessage } from "../src/main";
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
});
