// Structural, not grammy's Message type: this function needs exactly four fields,
// and typing it structurally keeps the tests free of building a whole fake
// Telegram Message just to assert a precedence rule.
export type QuoteSource = {
  quote?: { text?: string; is_manual?: boolean };
  reply_to_message?: { message_id?: number; text?: string; caption?: string };
};

export type ExtractedQuote = {
  text?: string;
  isManual: boolean;
  replyToMessageId?: string;
};

/**
 * Precedence exactly as the audit specifies (TG-111, spec §5.1):
 *   message.quote.text (with is_manual)  ->  reply_to_message.text
 *   ->  reply_to_message.caption  ->  nothing.
 *
 * `external_reply` (a quote of a message living in another chat) is deliberately
 * unsupported: its message id belongs to a different chat's numbering, so storing
 * it in reply_to would produce history links that resolve to the wrong row, or to
 * nothing at all.
 *
 * The quoted id is returned independently of which text branch won -- a reply to
 * a sticker has no readable text but is still a navigable anchor.
 */
export function extractQuote(message: QuoteSource): ExtractedQuote {
  const replied = message.reply_to_message;
  const replyToMessageId = replied?.message_id !== undefined ? String(replied.message_id) : undefined;

  const text = message.quote?.text ?? replied?.text ?? replied?.caption;
  // Only a `quote` object can be manual: is_manual means the human dragged a
  // selection. A whole-message reply is never manual, even though it quotes.
  const isManual = message.quote?.text !== undefined ? message.quote.is_manual === true : false;

  return {
    ...(text !== undefined ? { text } : {}),
    isManual,
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
  };
}
