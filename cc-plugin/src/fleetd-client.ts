import net from "node:net";

export type PushMessage = { type: "push_message"; text: string; meta: Record<string, string> };
export type ButtonRow = Array<{ text: string; data: string }>;
type HelloResponse = { ok: true; bot: string } | { ok: false; error: string };
type ReplyResponse = { ok: true } | { ok: false; error: string };

export type HistoryMessage = {
  id: number;
  ts: string;
  bot: string;
  chatId: string;
  messageId: string | null;
  source: string;
  userName: string | null;
  text: string | null;
  replyTo: string | null;
  metadata: string | null;
};

type MessagesResponse = { ok: true; messages: HistoryMessage[] } | { ok: false; error: string };

// A request awaiting its response line. `onFail` exists so a lost connection can
// settle the request instead of leaving it queued forever.
type PendingRequest = {
  onLine: (line: string) => void;
  onFail: (err: Error) => void;
};

export class FleetdClient {
  private socket: net.Socket | undefined;
  private buf = "";
  private pending: PendingRequest[] = [];
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
    this.pending.shift()?.onLine(line);
  }

  // Called when the socket closes or errors. fleetd restarting is routine during
  // development, and before this existed the close event was a no-op after
  // connect() resolved: every queued reply() hung forever with no error, which
  // hung the AI's tool call. Fail loudly, and drop the dead socket so the next
  // reply() fails fast with "not connected" rather than writing into the void.
  private failAll(reason: string): void {
    const queued = this.pending;
    this.pending = [];
    this.socket = undefined;
    this.buf = "";
    for (const req of queued) req.onFail(new Error(reason));
  }

  connect(sockPath: string, cwd: string, sessionId?: string): Promise<{ bot: string }> {
    return new Promise((resolve, reject) => {
      // Settles the connect() promise for failures that happen before the hello
      // handshake has a pending entry to fail through (e.g. the socket file does
      // not exist at all). Cleared once the handshake settles, so post-connect
      // socket failures go through failAll and never re-settle this promise.
      let settleConnect: ((err: Error) => void) | undefined = reject;

      const socket = net.createConnection(sockPath, () => {
        this.pending.push({
          onLine: (line) => {
            settleConnect = undefined;
            const res = JSON.parse(line) as HelloResponse;
            if (res.ok) resolve({ bot: res.bot });
            else reject(new Error(`hello rejected: ${res.error}`));
          },
          onFail: (err) => {
            settleConnect = undefined;
            reject(err);
          },
        });
        // Spread-if-defined so the key is absent rather than present-and-undefined:
        // fleetd parses hello with a zod strictObject.
        socket.write(
          this.encode({ type: "hello", cwd, ...(sessionId !== undefined ? { sessionId } : {}) })
        );
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
        this.failAll("fleetd connection lost (socket closed)");
        settleConnect?.(new Error("connection closed before hello completed"));
        settleConnect = undefined;
      });
      socket.on("error", (err) => {
        this.failAll(`fleetd connection lost (socket error: ${err})`);
        settleConnect?.(err instanceof Error ? err : new Error(String(err)));
        settleConnect = undefined;
      });

      this.socket = socket;
    });
  }

  reply(text: string, buttons?: ButtonRow[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("not connected"));
      this.pending.push({
        onLine: (line) => {
          const res = JSON.parse(line) as ReplyResponse;
          if (res.ok) resolve();
          else reject(new Error(`reply rejected: ${res.error}`));
        },
        onFail: reject,
      });
      this.socket.write(this.encode({ type: "reply", text, ...(buttons ? { buttons } : {}) }));
    });
  }

  private requestMessages(request: Record<string, unknown>): Promise<HistoryMessage[]> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("not connected"));
      this.pending.push({
        onLine: (line) => {
          const res = JSON.parse(line) as MessagesResponse;
          if (res.ok) resolve(res.messages);
          // Rejecting rather than resolving []: "the query was refused" and
          // "nothing matched" must never look the same to the AI.
          else reject(new Error(`request rejected: ${res.error}`));
        },
        onFail: reject,
      });
      this.socket.write(this.encode(request));
    });
  }

  history(opts: { messageId: string; before?: number; after?: number; bot?: string }): Promise<HistoryMessage[]> {
    return this.requestMessages({
      type: "history",
      messageId: opts.messageId,
      ...(opts.before !== undefined ? { before: opts.before } : {}),
      ...(opts.after !== undefined ? { after: opts.after } : {}),
      ...(opts.bot !== undefined ? { bot: opts.bot } : {}),
    });
  }

  search(opts: { query: string; limit?: number; bot?: string }): Promise<HistoryMessage[]> {
    return this.requestMessages({
      type: "search",
      query: opts.query,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.bot !== undefined ? { bot: opts.bot } : {}),
    });
  }

  onPush(handler: (msg: PushMessage) => void): void {
    this.pushHandler = handler;
  }

  close(): void {
    this.socket?.end();
  }
}
