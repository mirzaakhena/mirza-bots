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
    expect(received.params.content).toBe("pesan baru dari Telegram");
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
});
