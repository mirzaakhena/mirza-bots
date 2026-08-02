import net from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { encode, tryDecode, type Request, type Response, type PushMessage } from "./protocol";
import type { Config } from "../../../cc-plugin/src/engine/config";
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

// Called once the socket is genuinely accepting connections, and once if the bind
// fails instead. They exist because listen() is asynchronous: a caller that
// announces success on the line after startSocketServer() returns is guessing, and
// main.ts used to guess wrong -- printing "fleetd listening on X" and then failing
// to bind, leaving a daemon alive, deaf, and claiming to be healthy.
export type OnListening = () => void;
export type OnListenError = (err: Error) => void;

export function startSocketServer(
  sockPath: string,
  config: Config,
  handle: Handler,
  registry: ConnectionRegistry,
  onBind?: OnBind,
  onListening?: OnListening,
  onListenError?: OnListenError
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
          conn.sessionId = req.sessionId;
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

  // Both subscribed BEFORE listen(), so neither event can be missed in the gap
  // between listen() and the caller getting the server back.
  let isListening = false;
  server.once("listening", () => {
    isListening = true;
    onListening?.();
  });
  // Only attached when the caller supplied a handler: without one, a bind failure
  // must keep escaping as it does today rather than being silently swallowed here.
  if (onListenError) {
    server.on("error", (err) => {
      if (!isListening) {
        onListenError(err);
        return;
      }
      // Past the bind, this is no longer a startup failure and must not be reported
      // as one. It still has to be surfaced though: subscribing to "error" at all
      // stops node from raising it as an unhandled error event, so staying quiet
      // here would trade one silent failure for another.
      console.error(`fleetd: socket server error after listening: ${err}`);
    });
  }

  server.listen(sockPath);
  return server;
}
