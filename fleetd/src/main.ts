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
import { handleIncomingMessage, startPolling, type NormalizedMessage } from "./telegram/poller";
import { AlbumBuffer } from "./telegram/album-buffer";
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

    const deps = {
      config,
      conversationsDb,
      fleetDb,
      registry,
      inboxRoot: stateRoot(),
    };

    // One album buffer per bot, keyed by Telegram's media_group_id. onFlush fires
    // once the debounce window closes (all photos of the album have arrived) or
    // the hard cap trips, and is the only place that finally builds one grouped
    // NormalizedMessage out of however many photo URLs were collected.
    const albumBuffer = new AlbumBuffer<{ ctx: Filter<Context, "message:photo">; url: string }>(
      1500,
      8000,
      async (_mediaGroupId, items) => {
        const first = items[0]!.ctx;
        const msg: NormalizedMessage = {
          bot: botName,
          chatId: String(first.chat.id),
          userId: String(first.from?.id ?? first.chat.id),
          userName: first.from?.username,
          text: first.message.caption,
          photoUrls: items.map((i) => i.url),
          ts: new Date((first.message.date ?? Date.now() / 1000) * 1000).toISOString(),
        };
        lastChatByBot.set(botName, msg.chatId);
        await handleIncomingMessage(msg, deps);
      }
    );

    bot.on("message:text", async (ctx) => {
      const msg: NormalizedMessage = {
        bot: botName,
        chatId: String(ctx.chat.id),
        userId: String(ctx.from?.id ?? ctx.chat.id),
        userName: ctx.from?.username,
        text: ctx.message.text,
        ts: new Date((ctx.message.date ?? Date.now() / 1000) * 1000).toISOString(),
      };
      lastChatByBot.set(botName, msg.chatId);
      await handleIncomingMessage(msg, deps);
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

      const msg: NormalizedMessage = {
        bot: botName,
        chatId: String(ctx.chat.id),
        userId: String(ctx.from?.id ?? ctx.chat.id),
        userName: ctx.from?.username,
        text: ctx.message.caption,
        photoUrls: [url],
        ts: new Date((ctx.message.date ?? Date.now() / 1000) * 1000).toISOString(),
      };
      lastChatByBot.set(botName, msg.chatId);
      await handleIncomingMessage(msg, deps);
    });

    bot.on("callback_query:data", async (ctx) => {
      // MUST be first and unconditional -- otherwise the button spins forever on
      // the user's Telegram client. See spec §10's own recorded lesson from the
      // old rewrite (457 green unit tests, this exact call missing in production).
      await ctx.answerCallbackQuery();

      const chatId = ctx.callbackQuery.message?.chat.id ?? ctx.from.id;
      const msg: NormalizedMessage = {
        bot: botName,
        chatId: String(chatId),
        userId: String(ctx.from.id),
        userName: ctx.from.username,
        callbackData: ctx.callbackQuery.data,
        ts: new Date().toISOString(),
      };
      lastChatByBot.set(botName, msg.chatId);
      await handleIncomingMessage(msg, deps);
    });

    startPolling(bot, {
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
        await bot.api.sendMessage(
          chatId,
          req.text,
          replyMarkup ? { reply_markup: replyMarkup } : undefined
        );
        return { ok: true };
      }
      return { ok: false, error: "unknown_type" };
    },
    registry
  );

  console.log(`fleetd listening on ${sockPath}, ${Object.keys(config.bots).length} bot(s) polling`);
}

if (import.meta.main) {
  main();
}
