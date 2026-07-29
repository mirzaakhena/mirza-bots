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
});
