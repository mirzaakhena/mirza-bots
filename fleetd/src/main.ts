import { Bot, InlineKeyboard, type Context, type Filter } from "grammy";
import type { MessageEntity } from "grammy/types";
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
import { openConversationsDb, getMessagesAround, searchMessages } from "../../cc-plugin/src/engine/db/conversations-schema";
import { startSocketServer } from "./socket/server";
import { ConnectionRegistry, type BoundConnection } from "./socket/registry";
import { buildDoctorReport } from "../../cc-plugin/src/engine/doctor";
import {
  handleIncomingMessage,
  startPolling,
  type NormalizedMessage,
  type PollerDeps,
} from "../../cc-plugin/src/engine/telegram/poller";
import { AlbumBuffer } from "../../cc-plugin/src/engine/telegram/album-buffer";
import { extractQuote } from "../../cc-plugin/src/engine/telegram/quote";
import { safeName, MAX_DOCUMENT_BYTES } from "../../cc-plugin/src/engine/telegram/media";
import { drainQueue } from "./db/bot-inbox";
import type {
  Request,
  Response,
  ButtonRow,
  HistoryRequest,
  SearchRequest,
} from "./socket/protocol";
import type { Database } from "bun:sqlite";
import type { Config } from "../../cc-plugin/src/engine/config";
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
    | "text"
    | "photoUrls"
    | "callbackData"
    | "replyTo"
    | "quoteText"
    | "quoteIsManual"
    | "documents"
    | "oversizedDocument"
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

/**
 * Resolves which bot's history a request may read.
 *
 * K-3: "default read = your own conversation; peeking at another bot goes
 * through an explicit tool." So an absent `bot` means the caller's own, and
 * naming another one is the deliberate act. An unconfigured name is an error
 * rather than an empty result -- the AI must be able to tell "no such bot" apart
 * from "nothing matched".
 */
function resolveRequestedBot(
  requested: string | undefined,
  conn: BoundConnection,
  config: Config
): { ok: true; bot: string } | { ok: false; error: string } {
  if (!conn.boundBot) return { ok: false, error: "not_identified" };
  const bot = requested ?? conn.boundBot;
  if (!(bot in config.bots)) return { ok: false, error: "unknown_bot" };
  return { ok: true, bot };
}

export function handleHistoryRequest(
  req: HistoryRequest,
  conn: BoundConnection,
  config: Config,
  db: Database
): Response {
  const target = resolveRequestedBot(req.bot, conn, config);
  if (!target.ok) return target;

  return {
    ok: true,
    messages: getMessagesAround(db, {
      bot: target.bot,
      messageId: req.messageId,
      before: req.before ?? 0,
      // Defaults to looking forward: the motivating request is "trace a few
      // messages AFTER the one I quoted" (spec §9.2).
      after: req.after ?? 10,
    }),
  };
}

export function handleSearchRequest(
  req: SearchRequest,
  conn: BoundConnection,
  config: Config,
  db: Database
): Response {
  const target = resolveRequestedBot(req.bot, conn, config);
  if (!target.ok) return target;

  try {
    return { ok: true, messages: searchMessages(db, req.query, { bot: target.bot, limit: req.limit ?? 20 }) };
  } catch (err) {
    // FTS5 rejects plenty of ordinary-looking input (an unbalanced quote, a
    // trailing AND). The AI writes these queries, so name the problem in a way
    // that tells it to rephrase rather than leaving it a generic handler crash.
    return { ok: false, error: `bad_search_query: ${err}` };
  }
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
 * Decides how a message should read once one of its buttons has been tapped.
 *
 * Pure and exported for the same reason buildAlbumMessage is: these rules are
 * worth testing without standing up grammy or a bot. `null` means "leave the
 * message alone" -- there is nothing an editMessageText could do with a message
 * that has no text (a caption-only one, or one Telegram reports as inaccessible).
 *
 * What removes the keyboard is what this payload does NOT carry: Telegram drops
 * the markup of any message edited without a reply_markup. Left untouched, the
 * same prompt stays tappable forever and gets answered twice.
 *
 * The original entities are carried over because the edit text is sent as plain
 * text -- an edit without them silently strips every bold/italic/code run the
 * message had. Appending at the END is what keeps those offsets valid.
 */
export function buildTappedMessageEdit(
  message: { text?: string; entities?: MessageEntity[] } | undefined,
  callbackData: string
): { text: string; entities?: MessageEntity[] } | null {
  if (typeof message?.text !== "string") return null;

  // The callback DATA, not the button's label: Telegram does not send the label
  // back with the query, and fleetd never stored the keyboard it forwarded on the
  // AI's behalf. The data is the only truthful thing we have to show here.
  const edit: { text: string; entities?: MessageEntity[] } = {
    text: `${message.text}\n\n→ ${callbackData}`,
  };
  if (message.entities?.length) edit.entities = message.entities;
  return edit;
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

/**
 * U-5: guards the one button convention a phone screen cannot forgive.
 *
 * Button labels have to stay short, so the convention is bare numbers on the
 * buttons and a numbered list in the body saying what each number means. The AI
 * kept shipping the buttons and forgetting the list, leaving the human holding a
 * keyboard of `1` / `2` with nothing to read them against -- three times, and
 * once with an in-band apology for having done it twice. The rule lived only as
 * text asking the AI to remember, and text that asks nicely leaks; anything a
 * machine can guarantee, a machine guarantees.
 *
 * Pure and exported for the same reason buildAlbumMessage and
 * buildTappedMessageEdit are: the rule is worth testing without standing up
 * grammy. `null` means "send it".
 *
 * Deliberately fires only where the intent is unambiguous:
 *   - non-numeric labels are ignored entirely, so the convention's own required
 *     escape hatch (`✏️ Explain manually`) can never trip it, and a descriptive
 *     keyboard (`✅ Ya` / `❌ Tidak`) is none of this rule's business;
 *   - 2+ numeric labels are required, because a lone `1` is as likely to be a
 *     quantity as an option, and blocking a send on that guess costs more than
 *     it saves.
 */
export function findMissingButtonNarration(text: string, buttons?: ButtonRow[]): string | null {
  // Rows are cosmetic -- the human sees one keyboard however it is wrapped.
  const numeric = (buttons ?? []).flat().map((b) => b.text.trim()).filter((t) => /^\d+$/.test(t));
  if (numeric.length < 2) return null;

  const missing = [...new Set(numeric)].filter(
    // Anchored to the start of a line because that is what a legend looks like;
    // the same digit inside a sentence ("option 2 is safer") leaves the button
    // just as unreadable. [^\S\r\n] is "whitespace that is not a line break", so
    // a list nested under a heading still counts.
    (n) => !new RegExp(`^[^\\S\\r\\n]*${n}[.)]`, "m").test(text)
  );
  if (missing.length === 0) return null;

  // Naming the fix, not just the fault: a refusal that does not teach the
  // correct alternative is a rule the AI cannot comply with, and it will simply
  // retry the same message.
  return (
    `numbered_buttons_without_list: numeric button labels need a matching numbered line in the ` +
    `message text, and ${missing.map((n) => `"${n}"`).join(", ")} ` +
    `${missing.length === 1 ? "has" : "have"} none. Either add one line per number to the text ` +
    `(e.g. "1. Lanjut backup" / "2. Batalkan"), or drop the numbers and use short descriptive ` +
    `labels instead (e.g. "✅ Ya" / "❌ Tidak"). Nothing was sent -- fix and resend.`
  );
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
      if (req.type === "history") {
        return handleHistoryRequest(req, conn, config, conversationsDb);
      }
      if (req.type === "search") {
        return handleSearchRequest(req, conn, config, conversationsDb);
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
