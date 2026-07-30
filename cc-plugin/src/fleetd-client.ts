import net from "node:net";

export type PushMessage = { type: "push_message"; text: string; meta: Record<string, string> };
export type ButtonRow = Array<{ text: string; data: string }>;
type HelloResponse = { ok: true; bot: string } | { ok: false; error: string };
type ReplyResponse = { ok: true } | { ok: false; error: string };

export class FleetdClient {
  private socket: net.Socket | undefined;
  private buf = "";
  private pending: Array<(line: string) => void> = [];
  private pushHandler: ((msg: PushMessage) => void) | undefined;

  private encode(msg: unknown): string {
    return JSON.stringify(msg) + "\n";
  }

  private handleLine(line: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed.type === "push_message") {
      this.pushHandler?.(parsed as PushMessage);
      return;
    }
    const resolve = this.pending.shift();
    resolve?.(line);
  }

  connect(sockPath: string, cwd: string): Promise<{ bot: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(sockPath, () => {
        this.pending.push((line) => {
          const res = JSON.parse(line) as HelloResponse;
          if (res.ok) resolve({ bot: res.bot });
          else reject(new Error(`hello rejected: ${res.error}`));
        });
        socket.write(this.encode({ type: "hello", cwd }));
      });

      socket.on("data", (chunk) => {
        this.buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = this.buf.indexOf("\n")) !== -1) {
          const line = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 1);
          if (line.trim()) this.handleLine(line);
        }
      });

      socket.on("close", () => {
        reject(new Error("connection closed before hello completed"));
      });
      socket.on("error", reject);

      this.socket = socket;
    });
  }

  reply(text: string, buttons?: ButtonRow[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("not connected"));
      this.pending.push((line) => {
        const res = JSON.parse(line) as ReplyResponse;
        if (res.ok) resolve();
        else reject(new Error(`reply rejected: ${res.error}`));
      });
      this.socket.write(this.encode({ type: "reply", text, ...(buttons ? { buttons } : {}) }));
    });
  }

  onPush(handler: (msg: PushMessage) => void): void {
    this.pushHandler = handler;
  }

  close(): void {
    this.socket?.end();
  }
}
