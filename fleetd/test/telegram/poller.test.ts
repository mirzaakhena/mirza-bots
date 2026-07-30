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

  test("ignores a message from a chat id not in allowFrom", async () => {
    const conversationsDb = openConversationsDb(":memory:");
    const fleetDb = openFleetDb(":memory:");
    const registry = new ConnectionRegistry();

    await handleIncomingMessage(baseMsg({ chatId: "999", userId: "999", text: "bukan siapa-siapa" }), {
      config,
      conversationsDb,
      fleetDb,
      registry,
      inboxRoot: mkdtempSync(join(tmpdir(), "poller-test-")),
    });

    expect(searchMessages(conversationsDb, "bukan").length).toBe(0);
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
});

describe("startPolling retry loop", () => {
  test("retries with backoff min(1000*attempt,15000) and resets after success, giving up only when told to", async () => {
    const delays: number[] = [];
    let calls = 0;
    const start = async () => {
      calls++;
      if (calls < 3) throw new Error("ETIMEDOUT");
      // success: resolve and don't throw again
    };
    const sleep = async (ms: number) => {
      delays.push(ms);
    };

    await new Promise<void>((resolve) => {
      startPolling({} as any, {
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
