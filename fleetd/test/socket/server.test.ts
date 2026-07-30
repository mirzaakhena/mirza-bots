import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSocketServer } from "../../src/socket/server";
import { encode } from "../../src/socket/protocol";
import type { Response } from "../../src/socket/protocol";
import { ConnectionRegistry } from "../../src/socket/registry";
import { openFleetDb } from "../../src/db/fleet-schema";
import { queueMessage, drainQueue } from "../../src/db/bot-inbox";
import type { Config } from "../../src/config";

const testConfig: Config = {
  allowFrom: ["1"],
  bots: {
    "bot-01": { home: "/fake/bot-01/home", token: "t" },
    "bot-02": { home: "/fake/bot-02/home", token: "t" },
  },
};

let tmp: string;
let server: ReturnType<typeof startSocketServer> | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function sendRaw(sockPath: string, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath, () => client.write(raw));
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        client.end();
        resolve(buf.slice(0, idx));
      }
    });
    client.on("error", reject);
  });
}

describe("socket server", () => {
  test("responds to a known request type", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(
      sockPath,
      testConfig,
      () => ({
        ok: true,
        report: {
          botCount: 1,
          socketPath: sockPath,
          fleetTables: [],
          conversationsReady: true,
          version: "0.1.0",
        },
      }),
      new ConnectionRegistry()
    );

    const line = await sendRaw(sockPath, encode({ type: "doctor" }));
    const res = JSON.parse(line) as Response;
    expect(res.ok).toBe(true);
  });

  test("malformed JSON gets a bad_request response without crashing the server", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(
      sockPath,
      testConfig,
      () => ({
        ok: true,
        report: {
          botCount: 1,
          socketPath: sockPath,
          fleetTables: [],
          conversationsReady: true,
          version: "0.1.0",
        },
      }),
      new ConnectionRegistry()
    );

    const badLine = await sendRaw(sockPath, "{ not json\n");
    expect(JSON.parse(badLine)).toEqual({ ok: false, error: "bad_request" });

    // Server must still be alive for the next connection.
    const goodLine = await sendRaw(sockPath, encode({ type: "doctor" }));
    expect(JSON.parse(goodLine).ok).toBe(true);
  });

  test("handles a request split across two separate data events", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(
      sockPath,
      testConfig,
      () => ({
        ok: true,
        report: {
          botCount: 1,
          socketPath: sockPath,
          fleetTables: [],
          conversationsReady: true,
          version: "0.1.0",
        },
      }),
      new ConnectionRegistry()
    );

    const full = encode({ type: "doctor" });
    const mid = Math.floor(full.length / 2);
    const part1 = full.slice(0, mid);
    const part2 = full.slice(mid);

    const line = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection(sockPath, async () => {
        client.write(part1);
        // Force two distinct `data` events on the server side rather than
        // letting the OS coalesce the two writes into one.
        await new Promise((r) => setTimeout(r, 10));
        client.write(part2);
      });
      let buf = "";
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf("\n");
        if (idx !== -1) {
          client.end();
          resolve(buf.slice(0, idx));
        }
      });
      client.on("error", reject);
    });

    const res = JSON.parse(line) as Response;
    expect(res.ok).toBe(true);
  });

  test("handles two requests arriving in a single data event on the same connection", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(
      sockPath,
      testConfig,
      () => ({
        ok: true,
        report: {
          botCount: 1,
          socketPath: sockPath,
          fleetTables: [],
          conversationsReady: true,
          version: "0.1.0",
        },
      }),
      new ConnectionRegistry()
    );

    const twoLines = encode({ type: "doctor" }) + encode({ type: "doctor" });

    const lines = await new Promise<string[]>((resolve, reject) => {
      const client = net.createConnection(sockPath, () => client.write(twoLines));
      let buf = "";
      const collected: string[] = [];
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          collected.push(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
        if (collected.length >= 2) {
          client.end();
          resolve(collected);
        }
      });
      client.on("error", reject);
    });

    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect((JSON.parse(line) as Response).ok).toBe(true);
    }
  });

  test("hello binds a connection to the bot whose config home matches the declared cwd", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(sockPath, testConfig, () => ({ ok: true }), new ConnectionRegistry());

    const line = await sendRaw(sockPath, encode({ type: "hello", cwd: "/fake/bot-01/home" }));
    expect(JSON.parse(line)).toEqual({ ok: true, bot: "bot-01" });
  });

  test("hello with an unrecognized cwd is rejected", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(sockPath, testConfig, () => ({ ok: true }), new ConnectionRegistry());

    const line = await sendRaw(sockPath, encode({ type: "hello", cwd: "/nowhere" }));
    expect(JSON.parse(line)).toEqual({ ok: false, error: "unknown_cwd" });
  });

  test("a bound connection receives a push_message sent via the registry", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    const registry = new ConnectionRegistry();
    server = startSocketServer(sockPath, testConfig, () => ({ ok: true }), registry);

    const client = net.createConnection(sockPath);
    const lines: string[] = [];
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        lines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    await new Promise<void>((resolve) => client.on("connect", resolve));

    client.write(encode({ type: "hello", cwd: "/fake/bot-01/home" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, bot: "bot-01" });

    const delivered = registry.push("bot-01", { type: "push_message", text: "new message", meta: { chat_id: "1" } });
    expect(delivered).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(lines[1]!)).toEqual({ type: "push_message", text: "new message", meta: { chat_id: "1" } });

    client.end();
  });

  test("a second hello on an already-bound connection is rejected and the original binding is unchanged", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    const registry = new ConnectionRegistry();
    server = startSocketServer(sockPath, testConfig, () => ({ ok: true }), registry);

    const client = net.createConnection(sockPath);
    const lines: string[] = [];
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        lines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    await new Promise<void>((resolve) => client.on("connect", resolve));

    client.write(encode({ type: "hello", cwd: "/fake/bot-01/home" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, bot: "bot-01" });

    client.write(encode({ type: "hello", cwd: "/fake/bot-02/home" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(lines[1]!)).toEqual({ ok: false, error: "already_bound" });

    // Registry must still reflect only the original bot-01 binding: a push to
    // bot-01 is delivered, and no connection was ever registered under bot-02.
    const deliveredToOriginal = registry.push("bot-01", { type: "push_message", text: "hi", meta: {} });
    expect(deliveredToOriginal).toBe(true);

    const deliveredToSecond = registry.push("bot-02", { type: "push_message", text: "hi", meta: {} });
    expect(deliveredToSecond).toBe(false);

    client.end();
  });

  test("onBind drains bot_inbox on hello: a message queued while nobody was connected is delivered", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    const fleetDb = openFleetDb(":memory:");

    // Arrived while no plugin was connected, so it went to the offline queue.
    queueMessage(fleetDb, "bot-01", {
      type: "push_message",
      text: "pesan saat plugin mati",
      meta: { chat_id: "1" },
    });

    // The exact wiring main.ts uses for its onBind callback.
    const boundBots: string[] = [];
    server = startSocketServer(
      sockPath,
      testConfig,
      () => ({ ok: true }),
      new ConnectionRegistry(),
      (bot, conn) => {
        boundBots.push(bot);
        for (const msg of drainQueue(fleetDb, bot)) conn.send(msg);
      }
    );

    const client = net.createConnection(sockPath);
    const lines: string[] = [];
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        lines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    await new Promise<void>((resolve) => client.on("connect", resolve));

    client.write(encode({ type: "hello", cwd: "/fake/bot-01/home" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(boundBots).toEqual(["bot-01"]);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, bot: "bot-01" });
    // The queued message arrives on the freshly bound connection -- this is the
    // half of the offline queue that used to be missing entirely (queueMessage was
    // wired, drainQueue was never called in production, so queued messages were
    // lost forever despite sitting safely in the database).
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "push_message",
      text: "pesan saat plugin mati",
      meta: { chat_id: "1" },
    });

    // Drained means drained: reconnecting must not re-deliver it.
    expect(drainQueue(fleetDb, "bot-01").length).toBe(0);
    client.end();
  });

  test("a malformed reply request is answered with an error instead of hanging the caller", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(
      sockPath,
      testConfig,
      // Stand-in for main.ts's real reply handler, which throws on a `buttons`
      // value that is not an array of rows (rows.entries() is not a function).
      (req) => {
        if (req.type === "reply" && req.buttons) {
          for (const _row of req.buttons.entries()) void _row;
        }
        return { ok: true };
      },
      new ConnectionRegistry()
    );

    // `buttons` as a string, and a reply with no text at all: both must be rejected
    // at the boundary by zod rather than reaching the handler.
    const badButtons = await sendRaw(sockPath, encode({ type: "reply", text: "hi", buttons: "nope" }));
    expect(JSON.parse(badButtons)).toEqual({ ok: false, error: "bad_request" });

    const noText = await sendRaw(sockPath, encode({ type: "reply" }));
    expect(JSON.parse(noText)).toEqual({ ok: false, error: "bad_request" });

    const unknownType = await sendRaw(sockPath, encode({ type: "definitely_not_a_request" }));
    expect(JSON.parse(unknownType)).toEqual({ ok: false, error: "bad_request" });

    // A well-formed reply still gets through to the handler.
    const good = await sendRaw(
      sockPath,
      encode({ type: "reply", text: "hi", buttons: [[{ text: "Ya", data: "y" }]] })
    );
    expect(JSON.parse(good)).toEqual({ ok: true });
  });

  test("a handler that throws still gets a response line, and the server keeps serving", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    let calls = 0;
    server = startSocketServer(
      sockPath,
      testConfig,
      () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { ok: true };
      },
      new ConnectionRegistry()
    );

    // Without the try/catch around handle(), this throw escaped the socket's data
    // handler: no line was ever written and the caller waited forever.
    const failed = await sendRaw(sockPath, encode({ type: "doctor" }));
    const parsed = JSON.parse(failed);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("handler_failed");
    expect(parsed.error).toContain("boom");

    // Server and subsequent connections are unaffected.
    const after = await sendRaw(sockPath, encode({ type: "doctor" }));
    expect(JSON.parse(after)).toEqual({ ok: true });
  });

  test("an async handler that rejects is also answered rather than hanging", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(
      sockPath,
      testConfig,
      async () => {
        throw new Error("async boom");
      },
      new ConnectionRegistry()
    );

    const line = await sendRaw(sockPath, encode({ type: "doctor" }));
    const parsed = JSON.parse(line);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("async boom");
  });
});
