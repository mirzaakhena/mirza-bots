import { describe, test, expect } from "bun:test";
import { openFleetDb } from "../../src/db/fleet-schema";
import { queueMessage, drainQueue } from "../../src/db/bot-inbox";
import type { PushMessage } from "../../src/socket/protocol";

describe("bot_inbox", () => {
  test("queued messages are returned and marked delivered by drainQueue", () => {
    const db = openFleetDb(":memory:");
    const msg: PushMessage = { type: "push_message", text: "halo", meta: { chat_id: "1" } };

    queueMessage(db, "bot-01", msg);
    const drained = drainQueue(db, "bot-01");

    expect(drained).toEqual([msg]);
  });

  test("draining twice returns nothing the second time", () => {
    const db = openFleetDb(":memory:");
    queueMessage(db, "bot-01", { type: "push_message", text: "x", meta: {} });

    drainQueue(db, "bot-01");
    const secondDrain = drainQueue(db, "bot-01");

    expect(secondDrain).toEqual([]);
  });

  test("draining preserves insertion order and only returns the requested bot's messages", () => {
    const db = openFleetDb(":memory:");
    queueMessage(db, "bot-01", { type: "push_message", text: "first", meta: {} });
    queueMessage(db, "bot-02", { type: "push_message", text: "other-bot", meta: {} });
    queueMessage(db, "bot-01", { type: "push_message", text: "second", meta: {} });

    const drained = drainQueue(db, "bot-01");

    expect(drained.map((m) => m.text)).toEqual(["first", "second"]);
  });
});
