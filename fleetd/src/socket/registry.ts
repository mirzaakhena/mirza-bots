import type { PushMessage } from "./protocol";

export type BoundConnection = {
  send: (msg: PushMessage) => void;
  boundBot: string | null;
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
}
