import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetdClient } from "../src/fleetd-client";

let tmp: string;
let server: net.Server | undefined;

afterEach(() => {
  server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function startFakeFleetd(sockPath: string, onLine: (line: string, conn: net.Socket) => void) {
  if (existsSync(sockPath)) unlinkSync(sockPath);
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        onLine(buf.slice(0, idx), conn);
        buf = buf.slice(idx + 1);
      }
    });
  });
  server.listen(sockPath);
  return server;
}

describe("FleetdClient", () => {
  test("connect sends hello and resolves with the bound bot name", async () => {
    tmp = mkdtempSync(join(tmpdir(), "fleetd-client-test-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startFakeFleetd(sockPath, (line, conn) => {
      const req = JSON.parse(line);
      expect(req).toEqual({ type: "hello", cwd: "/fake/cwd" });
      conn.write(JSON.stringify({ ok: true, bot: "bot-01" }) + "\n");
    });

    const client = new FleetdClient();
    const result = await client.connect(sockPath, "/fake/cwd");
    expect(result).toEqual({ bot: "bot-01" });
    client.close();
  });

  test("reply sends a reply request and resolves once fleetd acknowledges", async () => {
    tmp = mkdtempSync(join(tmpdir(), "fleetd-client-test-"));
    const sockPath = join(tmp, "fleetd.sock");
    const received: any[] = [];
    server = startFakeFleetd(sockPath, (line, conn) => {
      const req = JSON.parse(line);
      received.push(req);
      if (req.type === "hello") conn.write(JSON.stringify({ ok: true, bot: "bot-01" }) + "\n");
      if (req.type === "reply") conn.write(JSON.stringify({ ok: true }) + "\n");
    });

    const client = new FleetdClient();
    await client.connect(sockPath, "/fake/cwd");
    await client.reply("halo dari AI");

    expect(received[1]).toEqual({ type: "reply", text: "halo dari AI" });
    client.close();
  });

  test("reply with buttons includes them in the request", async () => {
    tmp = mkdtempSync(join(tmpdir(), "fleetd-client-test-"));
    const sockPath = join(tmp, "fleetd.sock");
    const received: any[] = [];
    server = startFakeFleetd(sockPath, (line, conn) => {
      const req = JSON.parse(line);
      received.push(req);
      if (req.type === "hello") conn.write(JSON.stringify({ ok: true, bot: "bot-01" }) + "\n");
      if (req.type === "reply") conn.write(JSON.stringify({ ok: true }) + "\n");
    });

    const client = new FleetdClient();
    await client.connect(sockPath, "/fake/cwd");
    await client.reply("Pilih salah satu:", [[{ text: "Ya", data: "confirm_yes" }, { text: "Tidak", data: "confirm_no" }]]);

    expect(received[1]).toEqual({
      type: "reply",
      text: "Pilih salah satu:",
      buttons: [[{ text: "Ya", data: "confirm_yes" }, { text: "Tidak", data: "confirm_no" }]],
    });
    client.close();
  });

  test("onPush delivers a push_message the server sends unsolicited", async () => {
    tmp = mkdtempSync(join(tmpdir(), "fleetd-client-test-"));
    const sockPath = join(tmp, "fleetd.sock");
    let capturedConn: net.Socket | undefined;
    server = startFakeFleetd(sockPath, (line, conn) => {
      capturedConn = conn;
      const req = JSON.parse(line);
      if (req.type === "hello") conn.write(JSON.stringify({ ok: true, bot: "bot-01" }) + "\n");
    });

    const client = new FleetdClient();
    const pushes: any[] = [];
    client.onPush((msg) => pushes.push(msg));
    await client.connect(sockPath, "/fake/cwd");

    capturedConn!.write(JSON.stringify({ type: "push_message", text: "pesan baru", meta: { chat_id: "1" } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    expect(pushes).toEqual([{ type: "push_message", text: "pesan baru", meta: { chat_id: "1" } }]);
    client.close();
  });

  test("connect includes sessionId in the hello when one is given, and omits the key when not", async () => {
    tmp = mkdtempSync(join(tmpdir(), "fleetd-client-test-"));
    const sockPath = join(tmp, "fleetd.sock");
    const received: any[] = [];
    server = startFakeFleetd(sockPath, (line, conn) => {
      received.push(JSON.parse(line));
      conn.write(JSON.stringify({ ok: true, bot: "bot-01" }) + "\n");
    });

    const withSession = new FleetdClient();
    await withSession.connect(sockPath, "/fake/cwd", "sess-abc");
    withSession.close();

    const withoutSession = new FleetdClient();
    await withoutSession.connect(sockPath, "/fake/cwd");
    withoutSession.close();

    expect(received[0]).toEqual({ type: "hello", cwd: "/fake/cwd", sessionId: "sess-abc" });
    // The key must be absent, not present-and-undefined: fleetd validates hello
    // with a zod strictObject, and JSON.stringify drops undefined values anyway --
    // relying on that silently would break the moment the field became non-optional.
    expect(received[1]).toEqual({ type: "hello", cwd: "/fake/cwd" });
  });
});

// Every await below is bounded by withTimeout: the bug these tests cover is a
// promise that NEVER settles, so "it settled at all" is the actual assertion --
// leaning on bun's default test timeout would report it as a timeout, not a bug.
function withTimeout<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`did not settle within ${ms}ms (it hung)`)), ms)
    ),
  ]);
}

describe("FleetdClient when fleetd goes away", () => {
  test("an in-flight reply rejects when fleetd drops the connection instead of hanging forever", async () => {
    tmp = mkdtempSync(join(tmpdir(), "fleetd-client-test-"));
    const sockPath = join(tmp, "fleetd.sock");
    let capturedConn: net.Socket | undefined;
    // Answers hello, then deliberately never answers the reply -- it dies instead,
    // which is exactly what a fleetd restart looks like to the plugin.
    server = startFakeFleetd(sockPath, (line, conn) => {
      capturedConn = conn;
      const req = JSON.parse(line);
      if (req.type === "hello") conn.write(JSON.stringify({ ok: true, bot: "bot-01" }) + "\n");
      if (req.type === "reply") conn.destroy();
    });

    const client = new FleetdClient();
    await withTimeout(client.connect(sockPath, "/fake/cwd"));

    const inFlight = client.reply("balasan yang tidak akan pernah dijawab");
    // Caught with try/catch rather than `expect(...).rejects`: on Windows that
    // matcher does not let the event loop deliver the socket "close" this
    // rejection depends on, so the assertion hangs indefinitely even though the
    // client behaves correctly. A harness artifact, not a client bug -- awaiting
    // the promise plainly settles it on both platforms. The other two tests in
    // this block keep `.rejects` because their rejections do not wait on a socket
    // event.
    let failure: unknown;
    try {
      await withTimeout(inFlight);
    } catch (err) {
      failure = err;
    }
    expect(String(failure)).toMatch(/connection lost/i);

    expect(capturedConn).toBeDefined();
    client.close();
  });

  test("a reply issued after the connection died fails fast with not connected", async () => {
    tmp = mkdtempSync(join(tmpdir(), "fleetd-client-test-"));
    const sockPath = join(tmp, "fleetd.sock");
    let capturedConn: net.Socket | undefined;
    server = startFakeFleetd(sockPath, (line, conn) => {
      capturedConn = conn;
      const req = JSON.parse(line);
      if (req.type === "hello") conn.write(JSON.stringify({ ok: true, bot: "bot-01" }) + "\n");
    });

    const client = new FleetdClient();
    await withTimeout(client.connect(sockPath, "/fake/cwd"));

    // fleetd disappears while the plugin is idle.
    capturedConn!.destroy();
    await new Promise((r) => setTimeout(r, 50));

    // The dead socket must have been dropped, so this fails immediately rather
    // than writing into a socket nobody is reading and waiting forever.
    await expect(withTimeout(client.reply("halo?"))).rejects.toThrow(/not connected/);
    client.close();
  });

  test("connect rejects when the socket path does not exist", async () => {
    tmp = mkdtempSync(join(tmpdir(), "fleetd-client-test-"));
    const sockPath = join(tmp, "nothing-here.sock");

    const client = new FleetdClient();
    // No pending request exists yet at this point, so this must be rejected by the
    // connect promise directly -- not swallowed by the lost-connection path.
    await expect(withTimeout(client.connect(sockPath, "/fake/cwd"))).rejects.toThrow();
  });
});
