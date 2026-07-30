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
});
