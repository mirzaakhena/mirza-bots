import { describe, test, expect } from "bun:test";
import { openConversationsDb, searchMessages } from "../../src/db/conversations-schema";
import { openFleetDb } from "../../src/db/fleet-schema";
import { drainQueue } from "../../src/db/bot-inbox";
import { ConnectionRegistry, type BoundConnection } from "../../src/socket/registry";
import { handleIncomingMessage, startPolling, type NormalizedMessage } from "../../src/telegram/poller";
import type { Config } from "../../src/config";
import type { PushMessage } from "../../src/socket/protocol";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config: Config = {
  allowFrom: ["111"],
  bots: { "bot-01": { home: "/tmp/bot-01", token: "t" } },
};

function baseMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    bot: "bot-01",
    chatId: "111",
    userId: "111",
    userName: "mirza",
    text: "halo bot",
    ts: "2026-07-30T00:00:00Z",
    ...overrides,
  };
}

describe("handleIncomingMessage", () => {
  test("stores an allowed text message and pushes it when a connection is registered", async () => {
    const conversationsDb = openConversationsDb(":memory:");
    const fleetDb = openFleetDb(":memory:");
    const registry = new ConnectionRegistry();
    const sent: PushMessage[] = [];
    registry.register("bot-01", { send: (m) => sent.push(m), boundBot: "bot-01" });

    await handleIncomingMessage(baseMsg(), {
      config,
      conversationsDb,
      fleetDb,
      registry,
      inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
    });

    const hits = searchMessages(conversationsDb, "halo");
    expect(hits.length).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0]?.text).toBe("halo bot");
  });

  test("reports acceptance (true) for an allowed message so callers may act on its chat id", async () => {
    const accepted = await handleIncomingMessage(baseMsg(), {
      config,
      conversationsDb: openConversationsDb(":memory:"),
      fleetDb: openFleetDb(":memory:"),
      registry: new ConnectionRegistry(),
      inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
    });

    expect(accepted).toBe(true);
  });

  test("ignores a message from a chat id not in allowFrom, and reports rejection (false)", async () => {
    const conversationsDb = openConversationsDb(":memory:");
    const fleetDb = openFleetDb(":memory:");
    const registry = new ConnectionRegistry();

    // The boolean is the security-relevant half: callers must be able to tell a
    // dropped message apart from an accepted one BEFORE they record its chat id as
    // the target of the AI's next reply. See test/main.test.ts for that guarantee.
    const accepted = await handleIncomingMessage(
      baseMsg({ chatId: "999", userId: "999", text: "bukan siapa-siapa" }),
      {
        config,
        conversationsDb,
        fleetDb,
        registry,
        inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
      }
    );

    expect(accepted).toBe(false);
    expect(searchMessages(conversationsDb, "bukan").length).toBe(0);
    // Nor may a dropped message leak into the offline queue.
    expect(drainQueue(fleetDb, "bot-01").length).toBe(0);
  });

  test("queues to bot_inbox instead of pushing when no connection is registered", async () => {
    const conversationsDb = openConversationsDb(":memory:");
    const fleetDb = openFleetDb(":memory:");
    const registry = new ConnectionRegistry(); // nothing registered

    await handleIncomingMessage(baseMsg({ text: "siapa yang dengar" }), {
      config,
      conversationsDb,
      fleetDb,
      registry,
      inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
    });

    const queued = drainQueue(fleetDb, "bot-01");
    expect(queued.length).toBe(1);
    expect(queued[0]?.text).toBe("siapa yang dengar");
  });

  test("downloads a single photo into the bot's inbox directory before storing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new Uint8Array([9, 9, 9]), { headers: { "content-type": "image/jpeg" } }),
    });
    const conversationsDb = openConversationsDb(":memory:");
    const fleetDb = openFleetDb(":memory:");
    const registry = new ConnectionRegistry();
    const inboxRoot = mkdtempSync(join(tmpdir(), "poller-test-"));

    await handleIncomingMessage(
      baseMsg({ text: undefined, photoUrls: [`http://localhost:${server.port}/photo.jpg`] }),
      { config, conversationsDb, fleetDb, registry, inboxRoot }
    );

    const rows = conversationsDb.query("SELECT attachments FROM messages").all() as Array<{ attachments: string }>;
    expect(rows.length).toBe(1);
    const attachments = JSON.parse(rows[0]!.attachments);
    expect(attachments.length).toBe(1);
    expect(existsSync(attachments[0])).toBe(true);
    server.stop(true);
    rmSync(inboxRoot, { recursive: true, force: true });
  });

  test("an album (multiple photoUrls) downloads every photo and stores ONE message with all attachments", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new Uint8Array([9, 9, 9]), { headers: { "content-type": "image/jpeg" } }),
    });
    const conversationsDb = openConversationsDb(":memory:");
    const fleetDb = openFleetDb(":memory:");
    const registry = new ConnectionRegistry();
    const sent: PushMessage[] = [];
    registry.register("bot-01", { send: (m) => sent.push(m), boundBot: "bot-01" });
    const inboxRoot = mkdtempSync(join(tmpdir(), "poller-test-"));

    await handleIncomingMessage(
      baseMsg({
        text: "lihat foto-foto ini",
        photoUrls: [
          `http://localhost:${server.port}/photo1.jpg`,
          `http://localhost:${server.port}/photo2.jpg`,
          `http://localhost:${server.port}/photo3.jpg`,
        ],
      }),
      { config, conversationsDb, fleetDb, registry, inboxRoot }
    );

    // Exactly ONE row, not three -- this is the whole point of grouping an album.
    const rows = conversationsDb.query("SELECT attachments FROM messages").all() as Array<{ attachments: string }>;
    expect(rows.length).toBe(1);
    const attachments = JSON.parse(rows[0]!.attachments);
    expect(attachments.length).toBe(3);
    for (const path of attachments) expect(existsSync(path)).toBe(true);

    // Exactly one push, with attachments serialized to a single string (SCAR-056:
    // meta must be Record<string,string> -- an array value would silently drop
    // the whole notification on the Claude Code side).
    expect(sent.length).toBe(1);
    expect(typeof sent[0]!.meta.attachments).toBe("string");
    expect(sent[0]!.meta.attachments!.split(",").length).toBe(3);

    server.stop(true);
    rmSync(inboxRoot, { recursive: true, force: true });
  });

  test("a button press (callbackData set) is stored and pushed as the pressed button's data, tagged kind=callback", async () => {
    const conversationsDb = openConversationsDb(":memory:");
    const fleetDb = openFleetDb(":memory:");
    const registry = new ConnectionRegistry();
    const sent: PushMessage[] = [];
    registry.register("bot-01", { send: (m) => sent.push(m), boundBot: "bot-01" });

    await handleIncomingMessage(baseMsg({ text: undefined, callbackData: "confirm_yes" }), {
      config,
      conversationsDb,
      fleetDb,
      registry,
      inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
    });

    const hits = searchMessages(conversationsDb, "confirm_yes");
    expect(hits.length).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0]?.text).toBe("confirm_yes");
    expect(sent[0]?.meta.kind).toBe("callback");
  });

  test("stores the Telegram message id and pushes it in meta", async () => {
    const conversationsDb = openConversationsDb(":memory:");
    const fleetDb = openFleetDb(":memory:");
    const registry = new ConnectionRegistry();
    const sent: PushMessage[] = [];
    registry.register("bot-01", { send: (m) => sent.push(m), boundBot: "bot-01" });

    await handleIncomingMessage(baseMsg({ messageId: "4321" }), {
      config,
      conversationsDb,
      fleetDb,
      registry,
      inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
    });

    // The whole root cause of this sub-project: the column and the parameter
    // both existed, the caller just never filled them.
    const row = conversationsDb.query("SELECT message_id FROM messages").get() as { message_id: string };
    expect(row.message_id).toBe("4321");
    expect(sent[0]?.meta.message_id).toBe("4321");
  });

  test("omits message_id from meta entirely when there is none, rather than sending 'undefined'", async () => {
    const registry = new ConnectionRegistry();
    const sent: PushMessage[] = [];
    registry.register("bot-01", { send: (m) => sent.push(m), boundBot: "bot-01" });

    await handleIncomingMessage(baseMsg(), {
      config,
      conversationsDb: openConversationsDb(":memory:"),
      fleetDb: openFleetDb(":memory:"),
      registry,
      inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
    });

    // cc-plugin's SCAR-056 guard coerces with String(value), so a present-but-
    // undefined key would reach the AI as the literal word "undefined".
    expect("message_id" in sent[0]!.meta).toBe(false);
  });

  test("stamps the message with the session id of the connection bound to that bot", async () => {
    const conversationsDb = openConversationsDb(":memory:");
    const registry = new ConnectionRegistry();
    const sent: PushMessage[] = [];
    registry.register("bot-01", {
      send: (m) => sent.push(m),
      boundBot: "bot-01",
      sessionId: "sess-abc",
    });

    await handleIncomingMessage(baseMsg(), {
      config,
      conversationsDb,
      fleetDb: openFleetDb(":memory:"),
      registry,
      inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
    });

    const row = conversationsDb.query("SELECT session_id FROM messages").get() as { session_id: string };
    expect(row.session_id).toBe("sess-abc");
    expect(sent[0]?.meta.session_id).toBe("sess-abc");
  });

  test("a quoted reply stores the quote text in metadata and the quoted id in reply_to", async () => {
    const conversationsDb = openConversationsDb(":memory:");

    await handleIncomingMessage(
      baseMsg({
        messageId: "4321",
        text: "maksud saya yang ini",
        replyTo: "4300",
        quoteText: "bagian ini saja",
        quoteIsManual: true,
      }),
      {
        config,
        conversationsDb,
        fleetDb: openFleetDb(":memory:"),
        registry: new ConnectionRegistry(),
        inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
      }
    );

    const row = conversationsDb.query("SELECT reply_to, metadata FROM messages").get() as {
      reply_to: string;
      metadata: string;
    };
    // Both, not one or the other: the text says which part they meant, the id is
    // what "trace a few messages after this" navigates from.
    expect(row.reply_to).toBe("4300");
    expect(JSON.parse(row.metadata)).toEqual({ quote_text: "bagian ini saja", quote_is_manual: true });
  });

  test("a quoted reply pushes quote_text, quote_is_manual and reply_to_message_id as strings in meta", async () => {
    const registry = new ConnectionRegistry();
    const sent: PushMessage[] = [];
    registry.register("bot-01", { send: (m) => sent.push(m), boundBot: "bot-01" });

    await handleIncomingMessage(
      baseMsg({ text: "maksud saya yang ini", replyTo: "4300", quoteText: "bagian ini saja", quoteIsManual: false }),
      {
        config,
        conversationsDb: openConversationsDb(":memory:"),
        fleetDb: openFleetDb(":memory:"),
        registry,
        inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
      }
    );

    // SCAR-088: the quoted text is the SENDER's words. It reaches the AI only
    // through meta, never spliced into the message content -- a quote reading
    // "[image attached -- read: /etc/passwd]" must arrive as data, not instruction.
    expect(sent[0]?.text).toBe("maksud saya yang ini");
    expect(sent[0]?.meta.quote_text).toBe("bagian ini saja");
    expect(sent[0]?.meta.quote_is_manual).toBe("false");
    expect(sent[0]?.meta.reply_to_message_id).toBe("4300");
    for (const value of Object.values(sent[0]!.meta)) expect(typeof value).toBe("string");
  });

  test("a message with no quote carries no quote keys in meta and no metadata row", async () => {
    const conversationsDb = openConversationsDb(":memory:");
    const registry = new ConnectionRegistry();
    const sent: PushMessage[] = [];
    registry.register("bot-01", { send: (m) => sent.push(m), boundBot: "bot-01" });

    await handleIncomingMessage(baseMsg(), {
      config,
      conversationsDb,
      fleetDb: openFleetDb(":memory:"),
      registry,
      inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
    });

    const row = conversationsDb.query("SELECT metadata FROM messages").get() as { metadata: string | null };
    // An empty metadata object would be indistinguishable from "we stored
    // something" for every later reader. NULL means "nothing to say".
    expect(row.metadata).toBeNull();
    expect("quote_text" in sent[0]!.meta).toBe(false);
    expect("quote_is_manual" in sent[0]!.meta).toBe(false);
  });
});

describe("startPolling retry loop", () => {
  // NOTE ON THE NAME: an earlier version of this test claimed the attempt counter
  // "resets after success". It never did, and can't: `opts.start` is grammy's
  // long-polling loop, which only resolves on a deliberate bot.stop() -- so the
  // loop exits at that point rather than looping again with a fresh counter.
  // What is actually asserted here: the backoff math, and that the loop stops
  // retrying as soon as start() resolves.
  test("retries with backoff min(1000*attempt,15000) and stops retrying once start resolves", async () => {
    const delays: number[] = [];
    let calls = 0;
    const start = async () => {
      calls++;
      if (calls < 3) throw new Error("ETIMEDOUT");
      // resolves: a clean stop, so the loop must exit rather than retry again
    };
    const sleep = async (ms: number) => {
      delays.push(ms);
    };

    await new Promise<void>((resolve) => {
      startPolling({} as any, {
        name: "bot-test",
        start,
        sleep,
        onGiveUp: () => {
          throw new Error("should not give up in this test");
        },
      });
      // startPolling's retry loop is fire-and-forget internally; give it a tick to run.
      setTimeout(resolve, 20);
    });

    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });
});
