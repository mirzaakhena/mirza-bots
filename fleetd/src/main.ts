import { Bot, InlineKeyboard, type Context, type Filter } from "grammy";
import {
  ensureStateDirs,
  configPath,
  fleetDbPath,
  conversationsDbPath,
  socketPath,
  stateRoot,
} from "./paths";
import { loadConfig } from "./config";
import { openFleetDb } from "./db/fleet-schema";
import { openConversationsDb } from "./db/conversations-schema";
import { startSocketServer } from "./socket/server";
import { ConnectionRegistry } from "./socket/registry";
import { buildDoctorReport } from "./doctor";
import {
  handleIncomingMessage,
  startPolling,
  type NormalizedMessage,
  type PollerDeps,
} from "./telegram/poller";
import { AlbumBuffer } from "./telegram/album-buffer";
import { extractQuote } from "./telegram/quote";
import { drainQueue } from "./db/bot-inbox";
import type { Request, Response, ButtonRow } from "./socket/protocol";
import pkg from "../package.json";

const VERSION = pkg.version;

function apiRoot(): string {
  return process.env.TELEGRAM_API_ROOT ?? "https://api.telegram.org";
}

function makeBot(token: string): Bot {
  const root = process.env.TELEGRAM_API_ROOT;
  return root ? new Bot(token, { client: { apiRoot: root } }) : new Bot(token);
}

// grammy's ctx.getFile() only hands back a `file_path`; it has no download-URL
// builder, so build the URL by hand against the same apiRoot makeBot uses --
// that way tests route file downloads to the fake server too.
function fileUrl(token: string, filePath: string): string {
  return `${apiRoot()}/file/bot${token}/${filePath}`;
}

/**
 * Builds a NormalizedMessage out of the identity fields every Telegram handler
 * has in common, plus whatever payload that particular handler carries.
 *
 * Exported for tests. This existing as one function is what keeps the four
 * handlers below from each re-deriving the same five fields -- the duplication
 * that let the reply-hijack bug (lastChatByBot written before the allowlist gate)
 * exist in four separate copies.
 */
export function normalizeMessage(
  botName: string,
  ids: {
    chatId: string | number;
    userId: string | number;
    userName?: string;
    dateSeconds?: number;
    messageId?: string | number;
  },
  payload: Pick<
    NormalizedMessage,
    "text" | "photoUrls" | "callbackData" | "replyTo" | "quoteText" | "quoteIsManual"
  >
): NormalizedMessage {
  return {
    bot: botName,
    chatId: String(ids.chatId),
    userId: String(ids.userId),
    userName: ids.userName,
    messageId: ids.messageId !== undefined ? String(ids.messageId) : undefined,
    ts: new Date((ids.dateSeconds ?? Date.now() / 1000) * 1000).toISOString(),
    ...payload,
  };
}

export type AlbumItem = {
  messageId: number;
  chatId: string | number;
  userId: string | number;
  userName?: string;
  dateSeconds?: number;
  url: string;
  caption?: string;
};

/**
 * Turns however many photos the buffer collected into ONE NormalizedMessage.
 *
 * Pure and exported so the ordering and caption rules are testable without
 * standing up grammy, a bot, or main() -- the flush callback itself only adapts
 * grammy contexts into AlbumItems and calls this.
 *
 * Caption rules (spec §5.4 item 4), driven by how many members carry a caption:
 *   0  -> no text at all
 *   1  -> that caption verbatim, unlabelled (the ordinary case: the user is just
 *         talking about the album)
 *   2+ -> each labelled `Photo <n>:` by its position in the SORTED album, so the
 *         AI can tell which caption belongs to which file
 * Before this, only the first member's caption survived and the rest were lost.
 */
export function buildAlbumMessage(botName: string, items: AlbumItem[]): NormalizedMessage {
  // SCAR-055a: the buffer preserves arrival order, and photos arrive out of order
  // under load. Every downstream label is only correct once this sort has run.
  const ordered = [...items].sort((a, b) => a.messageId - b.messageId);
  const first = ordered[0]!;

  const captioned = ordered
    .map((item, i) => ({ position: i + 1, caption: item.caption }))
    .filter((c): c is { position: number; caption: string } => c.caption !== undefined);

  let text: string | undefined;
  if (captioned.length === 1) text = captioned[0]!.caption;
  else if (captioned.length > 1)
    text = captioned.map((c) => `Photo ${c.position}: ${c.caption}`).join("\n");

  return {
    ...normalizeMessage(
      botName,
      {
        chatId: first.chatId,
        userId: first.userId,
        userName: first.userName,
        dateSeconds: first.dateSeconds,
        messageId: first.messageId,
      },
      { text, photoUrls: ordered.map((i) => i.url) }
    ),
    isAlbum: true,
    messageIds: ordered.map((i) => String(i.messageId)),
  };
}

/**
 * The ONLY place `lastChatByBot` is ever written, and it happens strictly after
 * handleIncomingMessage's allowlist gate has accepted the message.
 *
 * Writing it before the gate (the old behaviour, duplicated across all four
 * handlers) meant any stranger who messaged the bot became the target of the AI's
 * next `reply` -- an information-disclosure bug, since their own message was
 * dropped but the AI's answer would have gone to them.
 *
 * Exported for tests.
 */
export async function deliverIncoming(
  msg: NormalizedMessage,
  deps: PollerDeps,
  lastChatByBot: Map<string, string>
): Promise<void> {
  const accepted = await handleIncomingMessage(msg, deps);
  if (accepted) lastChatByBot.set(msg.bot, msg.chatId);
}

function buildInlineKeyboard(rows: ButtonRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [i, row] of rows.entries()) {
    if (i > 0) kb.row();
    for (const btn of row) kb.text(btn.text, btn.data);
  }
  return kb;
}

export function main(): void {
  ensureStateDirs();
  const config = loadConfig(configPath());
  const fleetDb = openFleetDb(fleetDbPath());
  const conversationsDb = openConversationsDb(conversationsDbPath());
  const sockPath = socketPath();
  const registry = new ConnectionRegistry();

  // Track the most recent chat that messaged each bot, for `reply`'s target.
  // Intentional Tahap 2 simplification -- see plan's Global Constraints. In-memory,
  // reset on restart; superseded once real session routing lands in Tahap 4.
  const lastChatByBot = new Map<string, string>();

  process.on("unhandledRejection", (err) => {
    console.error(`fleetd: unhandled rejection (process stays alive): ${err}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`fleetd: uncaught exception (process stays alive): ${err}`);
  });

  const bots = new Map<string, Bot>();
  for (const [botName, botConfig] of Object.entries(config.bots)) {
    const bot = makeBot(botConfig.token);
    bots.set(botName, bot);

    const deps: PollerDeps = {
      config,
      conversationsDb,
      fleetDb,
      registry,
      inboxRoot: stateRoot(),
    };

    const deliver = (msg: NormalizedMessage) => deliverIncoming(msg, deps, lastChatByBot);

    // One album buffer per bot, keyed by Telegram's media_group_id. onFlush fires
    // once the debounce window closes (all photos of the album have arrived) or
    // the hard cap trips, and is the only place that finally builds one grouped
    // NormalizedMessage out of however many photo URLs were collected.
    const albumBuffer = new AlbumBuffer<{ ctx: Filter<Context, "message:photo">; url: string }>(
      1500,
      8000,
      async (mediaGroupId, items) => {
        // onFlush runs off a timer, detached from any grammy middleware chain, so a
        // rejection here would surface as a bare unhandled-rejection log with no
        // clue which bot or album it came from.
        try {
          await deliver(
            buildAlbumMessage(
              botName,
              items.map(({ ctx, url }) => ({
                messageId: ctx.message.message_id,
                chatId: ctx.chat.id,
                userId: ctx.from?.id ?? ctx.chat.id,
                userName: ctx.from?.username,
                dateSeconds: ctx.message.date,
                url,
                caption: ctx.message.caption,
              }))
            )
          );
        } catch (err) {
          console.error(`fleetd: album flush failed for ${botName}/${mediaGroupId}: ${err}`);
        }
      },
      10
    );

    bot.on("message:text", async (ctx) => {
      const quote = extractQuote(ctx.message);
      await deliver(
        normalizeMessage(
          botName,
          {
            chatId: ctx.chat.id,
            userId: ctx.from?.id ?? ctx.chat.id,
            userName: ctx.from?.username,
            dateSeconds: ctx.message.date,
            messageId: ctx.message.message_id,
          },
          {
            text: ctx.message.text,
            replyTo: quote.replyToMessageId,
            quoteText: quote.text,
            quoteIsManual: quote.isManual,
          }
        )
      );
    });

    bot.on("message:photo", async (ctx) => {
      // ctx.getFile() already resolves to the largest photo size in ctx.message.photo
      // (grammy picks photo[photo.length - 1] internally) -- no manual selection needed.
      const file = await ctx.getFile();
      if (!file.file_path) return;
      const url = fileUrl(botConfig.token, file.file_path);

      const mediaGroupId = ctx.message.media_group_id;
      if (mediaGroupId) {
        albumBuffer.add(mediaGroupId, { ctx, url });
        return;
      }

      const quote = extractQuote(ctx.message);
      await deliver(
        normalizeMessage(
          botName,
          {
            chatId: ctx.chat.id,
            userId: ctx.from?.id ?? ctx.chat.id,
            userName: ctx.from?.username,
            dateSeconds: ctx.message.date,
            messageId: ctx.message.message_id,
          },
          {
            text: ctx.message.caption,
            photoUrls: [url],
            replyTo: quote.replyToMessageId,
            quoteText: quote.text,
            quoteIsManual: quote.isManual,
          }
        )
      );
    });

    bot.on("callback_query:data", async (ctx) => {
      // MUST be first and unconditional -- otherwise the button spins forever on
      // the user's Telegram client. See spec §10's own recorded lesson from the
      // old rewrite (457 green unit tests, this exact call missing in production).
      //
      // But it must not be *fatal* either: Telegram rejects acks for queries that
      // are too old (common right after a restart), and letting that throw meant
      // the human saw a stuck spinner AND the AI never learned the button was
      // pressed. Log and carry on -- storing/pushing the press matters more.
      try {
        await ctx.answerCallbackQuery();
      } catch (err) {
        console.error(`fleetd: answerCallbackQuery failed for ${botName} (continuing): ${err}`);
      }

      await deliver(
        normalizeMessage(
          botName,
          {
            chatId: ctx.callbackQuery.message?.chat.id ?? ctx.from.id,
            userId: ctx.from.id,
            userName: ctx.from.username,
          },
          { callbackData: ctx.callbackQuery.data }
        )
      );
    });

    // Safety net, registered AFTER the `:data` handler above (which terminates the
    // middleware chain, so this never double-answers it): acknowledge any callback
    // query that carries no `data` field, which nothing this stage sends but which
    // would otherwise spin forever on the user's client.
    bot.on("callback_query", async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
    });

    startPolling(bot, {
      name: botName,
      start: () => bot.start(),
      onGiveUp: (err) => {
        console.error(`fleetd: poller for ${botName} gave up permanently: ${err}`);
      },
    });
  }

  startSocketServer(
    sockPath,
    config,
    async (req: Request, conn): Promise<Response> => {
      if (req.type === "doctor") {
        return {
          ok: true,
          report: buildDoctorReport(config, fleetDb, conversationsDb, sockPath, VERSION),
        };
      }
      if (req.type === "reply") {
        if (!conn.boundBot) return { ok: false, error: "not_identified" };
        const chatId = lastChatByBot.get(conn.boundBot);
        if (!chatId) return { ok: false, error: "no_known_chat" };
        const bot = bots.get(conn.boundBot);
        if (!bot) return { ok: false, error: "unknown_bot" };
        const replyMarkup = req.buttons ? buildInlineKeyboard(req.buttons) : undefined;
        // Telegram can reject a send for reasons entirely outside our control (429
        // rate limit, bot blocked by the user, text over 4096 chars, malformed
        // request). Without this catch the rejection escapes the socket server's
        // data handler and the client waits forever for a response line that never
        // comes -- so always answer, even when the send failed.
        try {
          await bot.api.sendMessage(
            chatId,
            req.text,
            replyMarkup ? { reply_markup: replyMarkup } : undefined
          );
        } catch (err) {
          return { ok: false, error: `send_failed: ${err}` };
        }
        return { ok: true };
      }
      return { ok: false, error: "unknown_type" };
    },
    registry,
    // The delivery half of the offline queue: messages that arrived while no
    // plugin was connected were safely written to bot_inbox but never handed over
    // to anyone. A plugin connecting is exactly the moment to flush them.
    (bot, conn) => {
      const queued = drainQueue(fleetDb, bot);
      if (queued.length === 0) return;
      console.log(`fleetd: delivering ${queued.length} queued message(s) to ${bot}`);
      for (const msg of queued) conn.send(msg);
    },
    // Announced from the socket's own "listening" event rather than on the line
    // after this call: listen() is asynchronous, so anything printed here would be
    // a guess. It used to guess wrong -- claiming to listen and then failing to
    // bind, in that order, in the same process.
    () => {
      console.log(
        `fleetd listening on ${sockPath}, ${Object.keys(config.bots).length} bot(s) polling`
      );
    },
    // A daemon that cannot accept connections is deaf: every bot it serves goes
    // quiet with no way to tell a broken fleetd from a quiet user. Staying alive
    // would hide exactly that, so this is fatal on purpose.
    (err) => {
      console.error(`fleetd: cannot listen on ${sockPath}: ${err}`);
      console.error("fleetd: exiting -- a daemon that cannot accept connections serves no one.");
      process.exit(1);
    }
  );
}

if (import.meta.main) {
  main();
}
