import type { Context, Filter } from "grammy";
import {
  ensureStateDirs,
  configPath,
  fleetDbPath,
  conversationsDbPath,
  stateRoot,
  lockPath,
} from "./paths";
import { loadConfig } from "./config";
import { resolveBotByCwd } from "./identity";
import { acquireBotLock, releaseBotLock } from "./lock";
import { openConversationsDb } from "./db/conversations-schema";
import { openFleetDb } from "./db/fleet-schema";
import { AlbumBuffer } from "./telegram/album-buffer";
import { extractQuote } from "./telegram/quote";
import { safeName, MAX_DOCUMENT_BYTES } from "./telegram/media";
import { startPolling, type NormalizedMessage, type PollerDeps } from "./telegram/poller";
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
} from "./messages";
import type { MessageSink, PushMessage } from "./sink";
import type { ButtonRow, HistoryMessage } from "./types";

/**
 * Everything cc-plugin needs from the Telegram side, in the shape its MCP tools
 * already expect.
 *
 * Deliberately identical to the old FleetdClient surface: the socket is being
 * removed, not the contract, and server.ts should not have to know which one it
 * is talking to.
 */
export type Engine = {
  bot: string;
  reply(text: string, buttons?: ButtonRow[]): Promise<void>;
  history(opts: {
    messageId: string;
    before?: number;
    after?: number;
    bot?: string;
  }): Promise<HistoryMessage[]>;
  search(opts: { query: string; limit?: number; bot?: string }): Promise<HistoryMessage[]>;
  onPush(handler: (msg: PushMessage) => void): void;
  close(): void;
};

export type EngineStart = { ok: true; engine: Engine } | { ok: false; message: string };

/**
 * Assembles one bot's engine inside the calling process.
 *
 * Two things differ from the daemon this replaces:
 *
 *  - it polls exactly ONE bot -- the one whose home is this session's cwd --
 *    rather than iterating every entry in config.bots. The fleet is still one
 *    config and one database; what is no longer shared is the process.
 *
 *  - every failure comes back as a sentence, never thrown. A thrown startup
 *    error is precisely what made cc-plugin vanish without a word (W-16), and a
 *    process that dies before it can speak leaves nothing to diagnose. The
 *    caller is expected to keep serving its tools and report this message
 *    through them.
 */
export function startEngine(cwd: string, sessionId?: string): EngineStart {
  let config;
  try {
    ensureStateDirs();
    config = loadConfig(configPath());
  } catch (err) {
    return { ok: false, message: `Cannot read the fleet config: ${(err as Error).message}` };
  }

  const identity = resolveBotByCwd(config, cwd);
  if (!identity.ok) return { ok: false, message: identity.message };
  const botName = identity.bot;
  const botConfig = config.bots[botName]!;

  const takeover = acquireBotLock(lockPath(botName), process.pid);
  if (takeover.previousPid !== null) {
    // Said out loud on purpose: from the older session's side this looks like
    // Telegram going quiet for no reason, and that silence is indistinguishable
    // from a broken bot unless somebody names it.
    console.error(
      `cc-plugin: took the ${botName} token over from pid ${takeover.previousPid}; ` +
        `that session stops receiving Telegram messages.`
    );
  }

  const conversationsDb = openConversationsDb(conversationsDbPath());
  const fleetDb = openFleetDb(fleetDbPath());

  // Held until onPush registers a handler rather than dropped: polling starts
  // before the MCP server finishes connecting, and losing that window would look
  // exactly like the bot ignoring the first message after startup.
  const buffered: PushMessage[] = [];
  let handler: ((msg: PushMessage) => void) | undefined;
  const sink: MessageSink = {
    push: (msg) => (handler ? handler(msg) : buffered.push(msg)),
    sessionId: () => sessionId,
  };

  const bot = makeBot(botConfig.token);
  const deps: PollerDeps = { config, conversationsDb, sink, inboxRoot: stateRoot() };

  // Tracks the chat `reply` answers. Written ONLY by deliverIncoming, strictly
  // after the allowlist gate accepted the message -- writing it before the gate
  // let a non-allowlisted stranger become the target of the AI's next reply.
  const lastChatByBot = new Map<string, string>();

  const deliver = (msg: NormalizedMessage) => deliverIncoming(msg, deps, lastChatByBot);

  // One album buffer, keyed by Telegram's media_group_id. onFlush fires
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
        console.error(`cc-plugin: album flush failed for ${botName}/${mediaGroupId}: ${err}`);
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
      console.error(`cc-plugin: answerCallbackQuery failed for ${botName} (continuing): ${err}`);
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
        console.error(`cc-plugin: keyboard edit failed for ${botName} (press already delivered): ${err}`);
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
      console.error(`cc-plugin: poller for ${botName} gave up permanently: ${err}`);
    },
  });

  return {
    ok: true,
    engine: {
      bot: botName,

      async reply(text: string, buttons?: ButtonRow[]): Promise<void> {
        const chatId = lastChatByBot.get(botName);
        if (!chatId) {
          throw new Error(
            "no_known_chat: this bot has not received a message yet, so there is nobody to reply to"
          );
        }
        // Before anything is built or sent: a rejected reply must leave no trace
        // on the user's phone, so this cannot sit after the sendMessage.
        const unnarrated = findMissingButtonNarration(text, buttons);
        if (unnarrated) throw new Error(unnarrated);
        const replyMarkup = buttons ? buildInlineKeyboard(buttons) : undefined;
        // Telegram rejects sends for plenty of reasons outside our control (429,
        // blocked by the user, text over 4096 chars). Letting it reject means the
        // tool call fails loudly instead of reporting a send that never happened.
        await bot.api.sendMessage(
          chatId,
          text,
          replyMarkup ? { reply_markup: replyMarkup } : undefined
        );
      },

      async history(opts): Promise<HistoryMessage[]> {
        const res = handleHistoryRequest(opts, botName, config, conversationsDb);
        // Thrown, not returned as {ok:false}: the caller awaits a value now
        // instead of reading one line off a socket, and "the query was refused"
        // must not arrive looking like "nothing matched".
        if (!res.ok) throw new Error(res.error);
        return res.messages;
      },

      async search(opts): Promise<HistoryMessage[]> {
        const res = handleSearchRequest(opts, botName, config, conversationsDb);
        if (!res.ok) throw new Error(res.error);
        return res.messages;
      },

      onPush(fn: (msg: PushMessage) => void): void {
        handler = fn;
        while (buffered.length > 0) fn(buffered.shift()!);
      },

      close(): void {
        releaseBotLock(lockPath(botName), process.pid);
        conversationsDb.close();
        fleetDb.close();
      },
    },
  };
}
