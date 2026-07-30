import type { Bot } from "grammy";
import type { Database } from "bun:sqlite";
import type { Config } from "../config";
import type { ConnectionRegistry } from "../socket/registry";
import type { PushMessage } from "../socket/protocol";
import { isAllowed } from "./allowlist";
import { downloadToFile } from "./media";
import { insertMessage } from "../db/conversations-schema";
import { queueMessage } from "../db/bot-inbox";
import { join } from "node:path";

export type NormalizedMessage = {
  bot: string;
  chatId: string;
  userId: string;
  userName?: string;
  text?: string;
  photoUrls?: string[];
  callbackData?: string;
  ts: string;
};

export type PollerDeps = {
  config: Config;
  conversationsDb: Database;
  fleetDb: Database;
  registry: ConnectionRegistry;
  inboxRoot: string;
};

export async function handleIncomingMessage(msg: NormalizedMessage, deps: PollerDeps): Promise<void> {
  if (!isAllowed(deps.config, msg.chatId)) return;

  const attachments: string[] = [];
  for (const [i, url] of (msg.photoUrls ?? []).entries()) {
    const destPath = join(deps.inboxRoot, "inbox", msg.bot, `${Date.now()}-${i}.jpg`);
    await downloadToFile(url, destPath);
    attachments.push(destPath);
  }

  // A button press has no `text` of its own -- its meaning IS the callback data
  // (e.g. "confirm_yes"). Store and push that as the message content so the AI
  // sees what was pressed; `kind: "callback"` in meta distinguishes it from a
  // message the human actually typed.
  const displayText = msg.callbackData ?? msg.text;

  insertMessage(deps.conversationsDb, {
    ts: msg.ts,
    bot: msg.bot,
    chatId: msg.chatId,
    source: "user",
    userId: msg.userId,
    userName: msg.userName,
    text: displayText,
    attachments: attachments.length > 0 ? JSON.stringify(attachments) : undefined,
  });

  const pushMsg: PushMessage = {
    type: "push_message",
    text: displayText ?? "(media)",
    meta: {
      chat_id: msg.chatId,
      user_id: msg.userId,
      ts: msg.ts,
      kind: msg.callbackData !== undefined ? "callback" : "message",
      ...(attachments.length > 0 ? { attachments: attachments.join(",") } : {}),
    },
  };

  const delivered = deps.registry.push(msg.bot, pushMsg);
  if (!delivered) {
    queueMessage(deps.fleetDb, msg.bot, pushMsg);
  }
}

export function startPolling(
  bot: Bot,
  opts: {
    start: () => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    onGiveUp?: (err: unknown) => void;
  }
): void {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // Optional chaining: a real grammy `Bot` always has `.catch`, but unit tests
  // exercising just the retry/backoff loop pass a bare stub (`{} as any`) with
  // no methods -- don't let registering the error handler crash the wrapper.
  bot.catch?.((err) => {
    console.error(`poller: handler error (polling continues): ${err}`);
  });

  (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await opts.start();
        return; // clean stop (e.g. bot.stop() called deliberately)
      } catch (err) {
        const delay = Math.min(1000 * attempt, 15000);
        await sleep(delay);
      }
    }
  })().catch((err) => {
    opts.onGiveUp?.(err);
  });
}
