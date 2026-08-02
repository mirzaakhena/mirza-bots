import { Bot, type Context, type Filter } from "grammy";
import {
  ensureStateDirs,
  configPath,
  fleetDbPath,
  conversationsDbPath,
  socketPath,
  stateRoot,
} from "../../cc-plugin/src/engine/paths";
import { loadConfig } from "../../cc-plugin/src/engine/config";
import { openFleetDb } from "../../cc-plugin/src/engine/db/fleet-schema";
import { openConversationsDb } from "../../cc-plugin/src/engine/db/conversations-schema";
import { startSocketServer } from "./socket/server";
import { ConnectionRegistry } from "./socket/registry";
import { buildDoctorReport } from "../../cc-plugin/src/engine/doctor";
import { startPolling, type NormalizedMessage, type PollerDeps } from "../../cc-plugin/src/engine/telegram/poller";
import { AlbumBuffer } from "../../cc-plugin/src/engine/telegram/album-buffer";
import { extractQuote } from "../../cc-plugin/src/engine/telegram/quote";
import { safeName, MAX_DOCUMENT_BYTES } from "../../cc-plugin/src/engine/telegram/media";
import { drainQueue, queueMessage } from "./db/bot-inbox";
import type { MessageSink } from "../../cc-plugin/src/engine/sink";
// The pure message rules moved to the engine in Task 5; this daemon is one of
// two callers until Task 6 removes it. Re-exported so fleetd/test/main.test.ts
// keeps importing them from here while it still exists.
import {
  makeBot,
  fileUrl,
  normalizeMessage,
  buildAlbumMessage,
  buildTappedMessageEdit,
  deliverIncoming,
  findMissingButtonNarration,
  buildInlineKeyboard,
  handleHistoryRequest,
  handleSearchRequest,
} from "../../cc-plugin/src/engine/messages";
export {
  normalizeMessage,
  buildAlbumMessage,
  buildTappedMessageEdit,
  deliverIncoming,
  findMissingButtonNarration,
  handleHistoryRequest,
  handleSearchRequest,
} from "../../cc-plugin/src/engine/messages";
import type { Request, Response } from "./socket/protocol";
import pkg from "../package.json";

const VERSION = pkg.version;

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

    // TEMPORARY bridge, dies with the socket layer in Task 6. The poller now
    // talks to a one-destination sink; the daemon still has N connections per
    // bot and an offline queue, so it presents them behind that interface.
    const sink: MessageSink = {
      push: (msg) => {
        if (!registry.push(botName, msg)) queueMessage(fleetDb, botName, msg);
      },
      sessionId: () => registry.sessionIdFor(botName),
    };

    const deps: PollerDeps = {
      config,
      conversationsDb,
      sink,
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

    bot.on("message:document", async (ctx) => {
      const doc = ctx.message.document;
      // safeName here, at the very first point a sender-chosen name enters the
      // system. Everything downstream (the inbox path, meta, the AI) sees only
      // the sanitized form.
      const fileName = safeName(doc.file_name ?? "document");
      const quote = extractQuote(ctx.message);
      const ids = {
        chatId: ctx.chat.id,
        userId: ctx.from?.id ?? ctx.chat.id,
        userName: ctx.from?.username,
        dateSeconds: ctx.message.date,
        messageId: ctx.message.message_id,
      };
      const common = {
        text: ctx.message.caption,
        replyTo: quote.replyToMessageId,
        quoteText: quote.text,
        quoteIsManual: quote.isManual,
      };

      // file_size is optional in the Telegram API. When it is absent we attempt
      // the download anyway: Telegram itself refuses anything over the limit, so
      // the worst case is a failed fetch that Task 4's tolerance already absorbs.
      if (doc.file_size !== undefined && doc.file_size > MAX_DOCUMENT_BYTES) {
        await deliver(
          normalizeMessage(botName, ids, {
            ...common,
            oversizedDocument: { fileName, sizeBytes: doc.file_size },
          })
        );
        return;
      }

      const file = await ctx.getFile();
      if (!file.file_path) return;

      await deliver(
        normalizeMessage(botName, ids, {
          ...common,
          documents: [
            { url: fileUrl(botConfig.token, file.file_path), fileName, sizeBytes: doc.file_size },
          ],
        })
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

      // Only now, with the press safely stored and pushed, tidy the keyboard away
      // so the same prompt cannot be answered a second time. Last on purpose:
      // Telegram refuses edits for plenty of ordinary reasons (message too old,
      // already edited, deleted by the user) and can be slow to say so, and none
      // of that is worth delaying -- or losing -- the press the AI is waiting for.
      const edit = buildTappedMessageEdit(ctx.callbackQuery.message, ctx.callbackQuery.data);
      if (edit) {
        try {
          await ctx.editMessageText(
            edit.text,
            edit.entities ? { entities: edit.entities } : undefined
          );
        } catch (err) {
          console.error(`fleetd: keyboard edit failed for ${botName} (press already delivered): ${err}`);
        }
      }
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
        // Before anything is built or sent: a rejected reply must leave no trace
        // on the user's phone, so this cannot sit after the sendMessage.
        const unnarrated = findMissingButtonNarration(req.text, req.buttons);
        if (unnarrated) return { ok: false, error: unnarrated };
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
      // The identity check used to live inside the handlers. It moved out here
      // when they moved to the engine: an engine process resolves its bot at
      // startup or refuses to run, so it has no "connected but nameless" state
      // to guard against. The socket does -- so the socket guards it.
      if (req.type === "history") {
        if (!conn.boundBot) return { ok: false, error: "not_identified" };
        return handleHistoryRequest(req, conn.boundBot, config, conversationsDb);
      }
      if (req.type === "search") {
        if (!conn.boundBot) return { ok: false, error: "not_identified" };
        return handleSearchRequest(req, conn.boundBot, config, conversationsDb);
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
