import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSocketServer } from "../src/socket/server";
import { encode } from "../src/socket/protocol";
import type { Response } from "../src/socket/protocol";

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
    server = startSocketServer(sockPath, () => ({
      ok: true,
      report: {
        botCount: 1,
        socketPath: sockPath,
        fleetTables: [],
        conversationsReady: true,
        version: "0.1.0",
      },
    }));

    const line = await sendRaw(sockPath, encode({ type: "doctor" }));
    const res = JSON.parse(line) as Response;
    expect(res.ok).toBe(true);
  });

  test("malformed JSON gets a bad_request response without crashing the server", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(sockPath, () => ({
      ok: true,
      report: {
        botCount: 1,
        socketPath: sockPath,
        fleetTables: [],
        conversationsReady: true,
        version: "0.1.0",
      },
    }));

    const badLine = await sendRaw(sockPath, "{ not json\n");
    expect(JSON.parse(badLine)).toEqual({ ok: false, error: "bad_request" });

    // Server must still be alive for the next connection.
    const goodLine = await sendRaw(sockPath, encode({ type: "doctor" }));
    expect(JSON.parse(goodLine).ok).toBe(true);
  });

  test("handles a request split across two separate data events", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mirza-bots-socket-"));
    const sockPath = join(tmp, "fleetd.sock");
    server = startSocketServer(sockPath, () => ({
      ok: true,
      report: {
        botCount: 1,
        socketPath: sockPath,
        fleetTables: [],
        conversationsReady: true,
        version: "0.1.0",
      },
    }));

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
    server = startSocketServer(sockPath, () => ({
      ok: true,
      report: {
        botCount: 1,
        socketPath: sockPath,
        fleetTables: [],
        conversationsReady: true,
        version: "0.1.0",
      },
    }));

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
});
