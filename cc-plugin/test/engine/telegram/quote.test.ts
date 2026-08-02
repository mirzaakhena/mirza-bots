import { describe, test, expect } from "bun:test";
import { extractQuote } from "../../../src/engine/telegram/quote";

describe("extractQuote", () => {
  test("prefers message.quote.text, and reports a hand-selected quote as manual", () => {
    const q = extractQuote({
      quote: { text: "bagian ini saja", is_manual: true },
      reply_to_message: { message_id: 4300, text: "kalimat panjang yang bagian ini saja dikutip" },
    });

    expect(q.text).toBe("bagian ini saja");
    expect(q.isManual).toBe(true);
    expect(q.replyToMessageId).toBe("4300");
  });

  test("a quote Telegram produced itself (no is_manual) is reported as not manual", () => {
    const q = extractQuote({
      quote: { text: "potongan otomatis" },
      reply_to_message: { message_id: 4300, text: "kalimat panjang" },
    });

    expect(q.text).toBe("potongan otomatis");
    expect(q.isManual).toBe(false);
  });

  test("falls back to reply_to_message.text when there is no quote", () => {
    const q = extractQuote({ reply_to_message: { message_id: 4300, text: "pesan yang dibalas" } });

    expect(q.text).toBe("pesan yang dibalas");
    expect(q.isManual).toBe(false);
    expect(q.replyToMessageId).toBe("4300");
  });

  test("falls back to reply_to_message.caption when the replied-to message is a photo", () => {
    const q = extractQuote({ reply_to_message: { message_id: 4300, caption: "caption fotonya" } });

    expect(q.text).toBe("caption fotonya");
    expect(q.replyToMessageId).toBe("4300");
  });

  test("returns nothing for a plain message, and ignores external_reply", () => {
    expect(extractQuote({})).toEqual({ isManual: false });
    // external_reply (a quote of a message in another chat) is explicitly out of
    // scope -- spec §5.1. Ignoring it must not accidentally produce a half-filled
    // quote pointing at an id that does not exist in this bot's history.
    expect(extractQuote({ external_reply: { message_id: 9, text: "dari chat lain" } } as any)).toEqual({
      isManual: false,
    });
  });

  test("keeps the quoted id even when the reply carries no readable text at all", () => {
    // A reply to a sticker/voice: no text, no caption. The id is still worth
    // keeping -- it is what "trace the messages after this one" navigates from.
    const q = extractQuote({ reply_to_message: { message_id: 4300 } });

    expect(q.text).toBeUndefined();
    expect(q.replyToMessageId).toBe("4300");
  });
});
