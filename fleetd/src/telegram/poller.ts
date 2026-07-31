import type { Bot } from "grammy";
import type { Database } from "bun:sqlite";
import type { Config } from "../config";
import type { ConnectionRegistry } from "../socket/registry";
import type { PushMessage } from "../socket/protocol";
import { isAllowed } from "./allowlist";
import { downloadToFile, redactToken } from "./media";
import { insertMessage, encodeMetadata, type MessageMetadata } from "../db/conversations-schema";
import { queueMessage } from "../db/bot-inbox";
import { join } from "node:path";

export type NormalizedMessage = {
  bot: string;
  chatId: string;
  userId: string;
  userName?: string;
  // Telegram's message id, as a string. The single field four separate features
  // were blocked on: history navigation, album ordering, album fallback, and
  // outgoing quotes (2.5-KELUAR).
  messageId?: string;
  text?: string;
  photoUrls?: string[];
  callbackData?: string;
  // Telegram message id this one replies to (Task 3 fills it).
  replyTo?: string;
  // The quoted text, and whether the human hand-selected it. Both reach the AI
  // through meta only (SCAR-088) -- they are the sender's words, not ours.
  quoteText?: string;
  quoteIsManual?: boolean;
  ts: string;
};

export type PollerDeps = {
  config: Config;
  conversationsDb: Database;
  fleetDb: Database;
  registry: ConnectionRegistry;
  inboxRoot: string;
};

/**
 * Stores and delivers one incoming message, or drops it if the sender is not
 * allowlisted.
 *
 * Returns whether the message passed the allowlist gate. Callers MUST NOT act on
 * a message's chat id (e.g. record it as the target for the AI's next reply)
 * before this reports `true`: doing so let a non-allowlisted stranger hijack the
 * reply target even though their own message was correctly dropped here.
 */
export type Downloadable = { url: string; fileName: string };
export type DownloadResult = { attachments: string[]; failedCount: number };

/**
 * Downloads every item, tolerating per-item failure (TG-105).
 *
 * Two deliberate properties:
 *  - `Promise.allSettled`, not a sequential await loop: one rejected fetch used
 *    to escape handleIncomingMessage entirely, so a single expired photo link
 *    meant the AI never learned the message existed at all.
 *  - Results are read back in input order, so callers can rely on the surviving
 *    attachments matching the order they asked for -- which is what makes album
 *    ordering (SCAR-055a) meaningful downstream.
 */
export async function downloadAll(items: Downloadable[], destDir: string): Promise<DownloadResult> {
  const settled = await Promise.allSettled(
    items.map(async (item) => {
      const destPath = join(destDir, item.fileName);
      await downloadToFile(item.url, destPath);
      return destPath;
    })
  );

  const attachments: string[] = [];
  let failedCount = 0;
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      attachments.push(outcome.value);
    } else {
      failedCount++;
      // redactToken on the URL as well as the reason: the reason from
      // downloadToFile is already redacted, but the URL here is raw.
      console.error(
        `poller: attachment download failed (${redactToken(items[i]!.url)}): ${outcome.reason}`
      );
    }
  }
  return { attachments, failedCount };
}

export async function handleIncomingMessage(
  msg: NormalizedMessage,
  deps: PollerDeps
): Promise<boolean> {
  if (!isAllowed(deps.config, msg.chatId)) return false;

  const inboxDir = join(deps.inboxRoot, "inbox", msg.bot);
  // Stamped once, outside the map: Date.now() per item could collide when two
  // downloads land in the same millisecond, and would make the names non-monotonic.
  const stamp = Date.now();
  const downloads: Downloadable[] = (msg.photoUrls ?? []).map((url, i) => ({
    url,
    fileName: `${stamp}-${i}.jpg`,
  }));
  const { attachments, failedCount } = await downloadAll(downloads, inboxDir);
  void failedCount; // Task 5 turns this into a user-visible notice for albums.

  // A button press has no `text` of its own -- its meaning IS the callback data
  // (e.g. "confirm_yes"). Store and push that as the message content so the AI
  // sees what was pressed; `kind: "callback"` in meta distinguishes it from a
  // message the human actually typed.
  const displayText = msg.callbackData ?? msg.text;

  // Read once: the same value goes into the row and into meta, and re-reading it
  // between the two would let them disagree if a connection dropped in between.
  const sessionId = deps.registry.sessionIdFor(msg.bot);

  // quote_is_manual is recorded only alongside a quote: on its own it would be a
  // fact about a quote that does not exist.
  const metadata: MessageMetadata = {
    ...(msg.quoteText !== undefined ? { quote_text: msg.quoteText } : {}),
    ...(msg.quoteText !== undefined ? { quote_is_manual: msg.quoteIsManual === true } : {}),
  };

  insertMessage(deps.conversationsDb, {
    ts: msg.ts,
    bot: msg.bot,
    chatId: msg.chatId,
    messageId: msg.messageId,
    source: "user",
    userId: msg.userId,
    userName: msg.userName,
    text: displayText,
    attachments: attachments.length > 0 ? JSON.stringify(attachments) : undefined,
    replyTo: msg.replyTo,
    metadata: encodeMetadata(metadata),
    sessionId,
  });

  const pushMsg: PushMessage = {
    type: "push_message",
    text: displayText ?? "(media)",
    meta: {
      chat_id: msg.chatId,
      user_id: msg.userId,
      ts: msg.ts,
      kind: msg.callbackData !== undefined ? "callback" : "message",
      // Spread-if-defined, never `key: value ?? undefined`: cc-plugin's SCAR-056
      // guard coerces with String(), which would turn a missing value into the
      // literal string "undefined" in front of the AI.
      ...(msg.messageId !== undefined ? { message_id: msg.messageId } : {}),
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      ...(msg.replyTo !== undefined ? { reply_to_message_id: msg.replyTo } : {}),
      ...(msg.quoteText !== undefined
        ? { quote_text: msg.quoteText, quote_is_manual: String(msg.quoteIsManual === true) }
        : {}),
      ...(attachments.length > 0 ? { attachments: attachments.join(",") } : {}),
    },
  };

  const delivered = deps.registry.push(msg.bot, pushMsg);
  if (!delivered) {
    queueMessage(deps.fleetDb, msg.bot, pushMsg);
  }

  return true;
}

/**
 * Runs `opts.start` (grammy's long-polling loop) and retries it with linear
 * backoff capped at 15s. The loop exits only when `start` resolves, which for a
 * real grammy bot means a deliberate `bot.stop()` -- so there is no
 * "reset the attempt counter after a while of healthy polling" behaviour here,
 * because `start` never resolves to report health.
 *
 * `opts.name` labels the retry logs; without them a bot with a revoked token
 * span silently forever with zero visible output.
 */
export function startPolling(
  bot: Bot,
  opts: {
    name?: string;
    start: () => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    onGiveUp?: (err: unknown) => void;
  }
): void {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const label = opts.name ?? "unnamed";

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
        console.error(
          `poller[${label}]: start failed (attempt ${attempt}, retry in ${delay}ms): ${err}`
        );
        await sleep(delay);
      }
    }
  })().catch((err) => {
    opts.onGiveUp?.(err);
  });
}
