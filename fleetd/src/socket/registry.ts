import type { PushMessage } from "./protocol";

export type BoundConnection = {
  send: (msg: PushMessage) => void;
  boundBot: string | null;
  // The Claude Code session that opened this connection, as reported by the
  // plugin in its `hello`. A snapshot taken at connect time, not a live tracker
  // (spec §8 risk 2) -- good enough to attribute stored messages to a session,
  // not authoritative session routing. That is Tahap 4's job.
  sessionId?: string;
};

export class ConnectionRegistry {
  private byBot = new Map<string, Set<BoundConnection>>();

  register(bot: string, conn: BoundConnection): void {
    let set = this.byBot.get(bot);
    if (!set) {
      set = new Set();
      this.byBot.set(bot, set);
    }
    set.add(conn);
  }

  unregister(bot: string, conn: BoundConnection): void {
    this.byBot.get(bot)?.delete(conn);
  }

  push(bot: string, msg: PushMessage): boolean {
    const set = this.byBot.get(bot);
    if (!set || set.size === 0) return false;
    for (const conn of set) conn.send(msg);
    return true;
  }

  sessionIdFor(bot: string): string | undefined {
    const set = this.byBot.get(bot);
    if (!set) return undefined;
    for (const conn of set) {
      if (conn.sessionId) return conn.sessionId;
    }
    return undefined;
  }
}
