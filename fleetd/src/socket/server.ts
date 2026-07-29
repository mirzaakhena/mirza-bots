import net from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { encode, tryDecode, type Request, type Response } from "./protocol";

export type Handler = (req: Request) => Response;

export function startSocketServer(sockPath: string, handle: Handler): net.Server {
  if (existsSync(sockPath)) unlinkSync(sockPath);

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const req = tryDecode(line);
        const res: Response = req ? handle(req) : { ok: false, error: "bad_request" };
        conn.write(encode(res));
      }
    });
    conn.on("error", () => {
      // Client disconnected mid-write; nothing to clean up per-connection.
    });
  });

  server.listen(sockPath);
  return server;
}
