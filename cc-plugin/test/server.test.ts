import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, TERSE_TURN_MARKER } from "../src/server";
import type { FleetdClient, PushMessage } from "../src/fleetd-client";

function fakeFleetdClient(overrides: Partial<FleetdClient> = {}): FleetdClient {
  return {
    connect: async () => ({ bot: "bot-01" }),
    reply: async () => {},
    onPush: () => {},
    close: () => {},
    ...overrides,
  } as unknown as FleetdClient;
}

describe("cc-plugin MCP server", () => {
  test("the reply tool proxies its text argument to FleetdClient.reply", async () => {
    const replied: string[] = [];
    const client = fakeFleetdClient({ reply: async (text: string) => { replied.push(text); } });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result = await mcpClient.callTool({ name: "reply", arguments: { text: "halo dari AI" } });

    expect(replied).toEqual(["halo dari AI"]);
    expect(result.isError).toBeFalsy();

    await mcpClient.close();
    await server.close();
  });

  test("the reply tool passes an optional buttons argument through to FleetdClient.reply", async () => {
    const calls: Array<{ text: string; buttons?: unknown }> = [];
    const client = fakeFleetdClient({
      reply: async (text: string, buttons?: any) => {
        calls.push({ text, buttons });
      },
    });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    await mcpClient.callTool({
      name: "reply",
      arguments: {
        text: "Pilih salah satu:",
        buttons: [[{ text: "Ya", data: "confirm_yes" }, { text: "Tidak", data: "confirm_no" }]],
      },
    });

    expect(calls).toEqual([
      {
        text: "Pilih salah satu:",
        buttons: [[{ text: "Ya", data: "confirm_yes" }, { text: "Tidak", data: "confirm_no" }]],
      },
    ]);

    await mcpClient.close();
    await server.close();
  });

  test("a push_message from fleetd is forwarded as notifications/claude/channel with string-only meta", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeFleetdClient({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });

    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => {
      received = n;
    };

    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    expect(capturedPushHandler).toBeDefined();
    capturedPushHandler!({
      type: "push_message",
      text: "pesan baru dari Telegram",
      meta: { chat_id: "1", user_id: "2", ts: "2026-07-30T00:00:00Z" },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(received.method).toBe("notifications/claude/channel");
    expect(received.params.content).toBe(`${TERSE_TURN_MARKER}\npesan baru dari Telegram`);
    for (const value of Object.values(received.params.meta)) {
      expect(typeof value).toBe("string"); // SCAR-056: every meta value must be a string
    }

    await mcpClient.close();
    await server.close();
  });

  test("a push_message meta containing a non-primitive value is serialized to a string before sending, never sent as an object/array", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeFleetdClient({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => {
      received = n;
    };
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    // Simulate what an album push would look like at the protocol boundary --
    // PushMessage.meta is already typed Record<string,string> upstream (fleetd side),
    // so this test exists to pin that buildServer never widens/breaks that guarantee
    // even if a future field is added; it passes an already-serialized multi-value
    // string (the realistic shape) and asserts it survives unchanged.
    capturedPushHandler!({
      type: "push_message",
      text: "album",
      meta: { chat_id: "1", attachments: "/a/1.jpg,/a/2.jpg" },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(received.params.meta.attachments).toBe("/a/1.jpg,/a/2.jpg");

    await mcpClient.close();
    await server.close();
  });

  test("a push_message meta containing genuinely non-string values (number, undefined) is coerced to strings, never passed through as-is", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeFleetdClient({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => {
      received = n;
    };
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    // PushMessage.meta is typed Record<string,string> upstream, but this test
    // pins the runtime-type-lie case SCAR-056 guards against: an upstream
    // caller that violates the type (e.g. a lost field from a partial spread,
    // or an optional field accessed but never set) must still never reach the
    // wire as a non-string. In particular, JSON.stringify(undefined) returns
    // the JS value `undefined` (not the string "undefined") -- a naive
    // fallback using JSON.stringify would silently drop this whole
    // notification. String(value) must be used instead.
    capturedPushHandler!({
      type: "push_message",
      text: "weird meta",
      meta: { chat_id: "1", count: 3 as any, missing: undefined as any },
    });
    await new Promise((r) => setTimeout(r, 50));

    for (const value of Object.values(received.params.meta)) {
      expect(typeof value).toBe("string");
    }
    expect(received.params.meta.count).toBe("3");
    expect(received.params.meta.missing).toBe("undefined");

    await mcpClient.close();
    await server.close();
  });

  test("the server declares MCP instructions that name the reply tool and the terse-turn marker", async () => {
    const client = fakeFleetdClient();
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const instructions = mcpClient.getInstructions();

    // The protocol lives here (once per session) instead of being re-sent with
    // every push. If this is ever dropped, the per-turn marker becomes a
    // meaningless string the AI has no definition for.
    expect(instructions).toBeTruthy();
    expect(instructions).toContain(TERSE_TURN_MARKER);
    expect(instructions).toContain("reply");

    await mcpClient.close();
    await server.close();
  });

  test("a pushed message is stamped with the terse-turn marker while preserving the original text verbatim", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeFleetdClient({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => { received = n; };
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    capturedPushHandler!({
      type: "push_message",
      text: "tolong cek status deployment",
      meta: { chat_id: "1", user_id: "2", kind: "message" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // The marker leads so the AI reads it before the message itself.
    expect(received.params.content.startsWith(TERSE_TURN_MARKER)).toBe(true);
    // The user's own words must survive untouched -- the marker is additive.
    expect(received.params.content).toContain("tolong cek status deployment");
    // Structured fields keep travelling in meta, not in the text (SCAR-056).
    expect(received.params.meta.kind).toBe("message");

    await mcpClient.close();
    await server.close();
  });

  test("a button press (kind: callback) gets the same marker -- no special case", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeFleetdClient({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => { received = n; };
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    capturedPushHandler!({
      type: "push_message",
      text: "confirm_yes",
      meta: { chat_id: "1", kind: "callback" },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(received.params.content).toBe(`${TERSE_TURN_MARKER}\nconfirm_yes`);

    await mcpClient.close();
    await server.close();
  });

  test("the read_history tool proxies to FleetdClient.history and returns the rows as JSON", async () => {
    const calls: any[] = [];
    const row = {
      id: 7, ts: "t", bot: "bot-01", chatId: "111", messageId: "101", source: "user",
      userName: "mirza", text: "pesan kedua", replyTo: null, metadata: null,
    };
    const client = fakeFleetdClient({
      history: async (opts: any) => {
        calls.push(opts);
        return [row];
      },
    });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result: any = await mcpClient.callTool({
      name: "read_history",
      arguments: { message_id: "101", after: 3 },
    });

    // snake_case at the tool boundary (what the AI sees, matching the meta keys
    // it was given), camelCase on the wire.
    expect(calls).toEqual([{ messageId: "101", after: 3 }]);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("pesan kedua");

    await mcpClient.close();
    await server.close();
  });

  test("the search_history tool proxies to FleetdClient.search and passes an explicit bot through", async () => {
    const calls: any[] = [];
    const client = fakeFleetdClient({
      search: async (opts: any) => {
        calls.push(opts);
        return [];
      },
    });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result: any = await mcpClient.callTool({
      name: "search_history",
      arguments: { query: "backup", bot: "bot-02" },
    });

    // Crossing to another bot happens ONLY because `bot` was named (K-3).
    expect(calls).toEqual([{ query: "backup", bot: "bot-02" }]);
    // An empty result reads as words, not as "[]" -- the AI should not have to
    // parse an empty array to learn nothing matched.
    expect(result.content[0].text).toContain("No messages");

    await mcpClient.close();
    await server.close();
  });

  test("a search that fleetd refuses comes back as a tool error, not as an empty result", async () => {
    const client = fakeFleetdClient({
      search: async () => {
        throw new Error("request rejected: bad_search_query: unterminated string");
      },
    });
    const server = buildServer(client);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result: any = await mcpClient.callTool({ name: "search_history", arguments: { query: 'backup"' } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("bad_search_query");

    await mcpClient.close();
    await server.close();
  });
});
