import { describe, test, expect } from "bun:test";
import { ConnectionRegistry } from "../../src/socket/registry";
import type { PushMessage } from "../../src/socket/protocol";

function fakeConn() {
  const sent: PushMessage[] = [];
  return { conn: { send: (msg: PushMessage) => sent.push(msg), boundBot: null as string | null }, sent };
}

describe("ConnectionRegistry", () => {
  test("push delivers to a registered connection and returns true", () => {
    const registry = new ConnectionRegistry();
    const { conn, sent } = fakeConn();
    registry.register("bot-01", conn);

    const msg: PushMessage = { type: "push_message", text: "hi", meta: { chat_id: "1" } };
    const delivered = registry.push("bot-01", msg);

    expect(delivered).toBe(true);
    expect(sent).toEqual([msg]);
  });

  test("push returns false when no connection is registered for that bot", () => {
    const registry = new ConnectionRegistry();
    const delivered = registry.push("bot-01", { type: "push_message", text: "hi", meta: {} });
    expect(delivered).toBe(false);
  });

  test("unregister stops further delivery to that connection", () => {
    const registry = new ConnectionRegistry();
    const { conn, sent } = fakeConn();
    registry.register("bot-01", conn);
    registry.unregister("bot-01", conn);

    const delivered = registry.push("bot-01", { type: "push_message", text: "hi", meta: {} });
    expect(delivered).toBe(false);
    expect(sent.length).toBe(0);
  });

  test("push delivers to every connection registered for the same bot", () => {
    const registry = new ConnectionRegistry();
    const a = fakeConn();
    const b = fakeConn();
    registry.register("bot-01", a.conn);
    registry.register("bot-01", b.conn);

    registry.push("bot-01", { type: "push_message", text: "hi", meta: {} });

    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
  });
});
