/**
 * Shapes shared by more than one part of the engine.
 *
 * These used to live in socket/protocol.ts because both sides of the wire needed
 * them. The wire is going away; the shapes are not. They sit here so there stays
 * exactly one definition of each (K-15) -- during the transition socket/protocol
 * re-exports from this file rather than declaring its own copy.
 */

/** One button on an inline keyboard row. `data` comes back as the next message. */
export type Button = { text: string; data: string };
export type ButtonRow = Button[];

/** One stored message, as history and search hand it to the AI. */
export type HistoryMessage = {
  id: number;
  ts: string;
  bot: string;
  chatId: string;
  messageId: string | null;
  source: string;
  userName: string | null;
  text: string | null;
  replyTo: string | null;
  metadata: string | null;
};

/** Who holds one bot's Telegram token right now, if anyone. */
export type LockStatus = { bot: string; pid: number | null; alive: boolean };

export type DoctorReport = {
  /** Nama bot yang dilayani folder ini. Armada tidak lagi punya wakil tunggal. */
  bot: string;
  /** Siapa memegang token bot INI, kalau ada -- see doctor.ts for why. */
  lock: LockStatus;
  conversationsReady: boolean;
  version: string;
};

/**
 * What a history/search call answers.
 *
 * "The query was refused" and "nothing matched" must never look the same to the
 * AI, so a refusal is an explicit error rather than an empty list.
 */
export type MessagesResult = { ok: true; messages: HistoryMessage[] } | { ok: false; error: string };
