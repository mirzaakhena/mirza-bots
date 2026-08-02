import { Bot, InlineKeyboard } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { Database } from "bun:sqlite";
import type { Config } from "./config";
import { getMessagesAround, searchMessages } from "./db/conversations-schema";
import {
  handleIncomingMessage,
  type NormalizedMessage,
  type PollerDeps,
} from "./telegram/poller";
import type { ButtonRow, MessagesResult } from "./types";

export function apiRoot(): string {
  return process.env.TELEGRAM_API_ROOT ?? "https://api.telegram.org";
}

export function makeBot(token: string): Bot {
  const root = process.env.TELEGRAM_API_ROOT;
  return root ? new Bot(token, { client: { apiRoot: root } }) : new Bot(token);
}

// grammy's ctx.getFile() only hands back a `file_path`; it has no download-URL
// builder, so build the URL by hand against the same apiRoot makeBot uses --
// that way tests route file downloads to the fake server too.
export function fileUrl(token: string, filePath: string): string {
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
 * through an explicit tool." So an absent `bot` means this session's own, and
 * naming another one is the deliberate act. An unconfigured name is an error
 * rather than an empty result -- the AI must be able to tell "no such bot" apart
 * from "nothing matched".
 */
function resolveRequestedBot(
  requested: string | undefined,
  ownBot: string,
  config: Config
): { ok: true; bot: string } | { ok: false; error: string } {
  const bot = requested ?? ownBot;
  if (!(bot in config.bots)) return { ok: false, error: "unknown_bot" };
  return { ok: true, bot };
}

export function handleHistoryRequest(
  req: { messageId: string; before?: number; after?: number; bot?: string },
  ownBot: string,
  config: Config,
  db: Database
): MessagesResult {
  const target = resolveRequestedBot(req.bot, ownBot, config);
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
  req: { query: string; limit?: number; bot?: string },
  ownBot: string,
  config: Config,
  db: Database
): MessagesResult {
  const target = resolveRequestedBot(req.bot, ownBot, config);
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

export function buildInlineKeyboard(rows: ButtonRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [i, row] of rows.entries()) {
    if (i > 0) kb.row();
    for (const btn of row) kb.text(btn.text, btn.data);
  }
  return kb;
}

