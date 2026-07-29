import net from "node:net";
import { socketPath } from "../src/paths";
import { encode } from "../src/socket/protocol";

function askDoctor(sockPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath, () => {
      client.write(encode({ type: "doctor" }));
    });
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        client.end();
        resolve(JSON.parse(buf.slice(0, idx)));
      }
    });
    client.on("error", reject);
    client.on("close", () => reject(new Error("connection closed before a response was received")));
  });
}

const res: any = await askDoctor(socketPath());
console.log(JSON.stringify(res, null, 2));
if (!res.ok) process.exit(1);
