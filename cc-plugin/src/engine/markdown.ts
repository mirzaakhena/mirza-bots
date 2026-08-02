import telegramifyMarkdown from "telegramify-markdown";

/**
 * Convert a CommonMark-style string into Telegram MarkdownV2.
 *
 * Applied to EVERY reply, with no opt-in flag. The old system had a `format`
 * parameter the AI was supposed to remember, and the user watched `**bold**`
 * arrive raw on their phone -- which is what a rule that merely asks looks like
 * once it leaks. Anything a machine can guarantee, a machine guarantees (K-5).
 *
 * Why the conversion is needed at all: MarkdownV2 requires every `.` `-` `(`
 * `)` `!` `+` outside markup to be backslash-escaped, or the API rejects the
 * whole message with a 400. That is a rule no one should have to hold in their
 * head while writing a sentence.
 *
 * Backed by `telegramify-markdown` (remark-based), the same package the old
 * system settled on -- a real parser rather than a regex, so text that merely
 * looks like markup is left alone and code spans stay literal.
 */
export function commonMarkToMarkdownV2(input: string): string {
  // Some versions throw on empty input. Short-circuit so an empty reply surfaces
  // as an empty reply rather than a confusing library error.
  if (!input) return "";
  return telegramifyMarkdown(input);
}
