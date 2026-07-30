import net from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { encode, tryDecode, type Request, type Response, type PushMessage } from "./protocol";
import type { Config } from "../config";
import { ConnectionRegistry, type BoundConnection } from "./registry";

export type Handler = (req: Request, conn: BoundConnection) => Response | Promise<Response>;

// Fired right after a `hello` binds a connection to a bot, with that connection
// already registered and able to receive pushes. main.ts uses it to drain
// bot_inbox -- messages that arrived while no plugin was connected.
export type OnBind = (bot: string, conn: BoundConnection) => void;

function resolveBotByCwd(config: Config, cwd: string): string | null {
  for (const [name, bot] of Object.entries(config.bots)) {
    if (bot.home === cwd) return name;
  }
  return null;
}

export function startSocketServer(
  sockPath: string,
  config: Config,
  handle: Handler,
  registry: ConnectionRegistry,
  onBind?: OnBind
): net.Server {
  if (existsSync(sockPath)) unlinkSync(sockPath);

  const server = net.createServer((rawConn) => {
    const conn: BoundConnection = {
      send: (msg: PushMessage) => rawConn.write(encode(msg)),
      boundBot: null,
    };

    let buf = "";
    rawConn.on("data", async (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;

        const req = tryDecode(line);
        if (!req) {
          rawConn.write(encode({ ok: false, error: "bad_request" }));
          continue;
        }

        if (req.type === "hello") {
          if (conn.boundBot) {
            rawConn.write(encode({ ok: false, error: "already_bound" }));
            continue;
          }
          const bot = resolveBotByCwd(config, req.cwd);
          if (!bot) {
            rawConn.write(encode({ ok: false, error: "unknown_cwd" }));
            continue;
          }
          conn.boundBot = bot;
          registry.register(bot, conn);
          rawConn.write(encode({ ok: true, bot }));
          // After the hello response, so the client reads its handshake answer
          // before any drained push. Guarded: a throwing onBind must not take
          // down the connection or the server.
          try {
            onBind?.(bot, conn);
          } catch (err) {
            console.error(`fleetd: onBind failed for ${bot}: ${err}`);
          }
          continue;
        }

        // A handler throwing used to escape this data handler entirely: no
        // response line was ever written and the caller waited forever. Always
        // answer, whatever the handler does.
        let res: Response;
        try {
          res = await handle(req, conn);
        } catch (err) {
          res = { ok: false, error: `handler_failed: ${err}` };
        }
        rawConn.write(encode(res));
      }
    });

    rawConn.on("close", () => {
      if (conn.boundBot) registry.unregister(conn.boundBot, conn);
    });

    rawConn.on("error", () => {
      // Client disconnected mid-write; close handler above still fires and unregisters.
    });
  });

  server.listen(sockPath);
  return server;
}
