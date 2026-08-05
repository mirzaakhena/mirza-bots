/**
 * Validasi input tool MCP `send_slash`. Murni: tidak menyentuh disk.
 *
 * Terpisah dari `map.ts` dengan sengaja. `map.ts` menerjemahkan slash TELEGRAM
 * (yang punya inovasi lapisan sendiri seperti /new) menjadi payload wrapper.
 * Berkas ini melayani AI yang menyuntik perintah CLAUDE CODE apa adanya --
 * tidak ada terjemahan, hanya pagar.
 */
import type { WrapperPayload } from "./map";

/**
 * Sama dengan MAX_BATCH_ITEMS di `cc-wrapper/src/inbox.ts`.
 *
 * Paket terpisah, jadi angkanya tidak bisa di-import dan memang disalin. Yang
 * menjaga keduanya tidak berbeda pendapat adalah sebuah test yang memakukan
 * angkanya -- kalau wrapper menaikkan batasnya, test di sini yang merah, bukan
 * user yang menemukan batch-nya ditolak sesudah AI diberi tahu ia terkirim.
 */
export const MAX_SLASH_BATCH = 8;

/**
 * Perintah lapisan Telegram: TIDAK ADA di Claude Code.
 *
 * `pty_send_slash` lama menolaknya dengan alasan yang tidak berubah -- CC
 * menjawab "unknown command" di layar dan AI tidak pernah tahu perintahnya
 * menguap. `/new` punya pengganti yang sah, jadi penolakannya menunjuknya.
 */
const TELEGRAM_ONLY: Record<string, string> = {
  "/new": 'Use a batch instead: ["/clear", "/rename <name>"].',
  "/switch": "There is no Claude Code equivalent.",
  "/delete": "There is no Claude Code equivalent.",
  "/effort": "There is no Claude Code equivalent.",
};

export type SlashSendInput = { command?: string; commands?: string[] };

export type SlashSendResult =
  | { ok: true; payload: WrapperPayload; ack: string }
  | { ok: false; message: string };

/** Nama perintah = potongan sebelum spasi pertama. */
function nameOf(command: string): string {
  const space = command.indexOf(" ");
  return space === -1 ? command : command.slice(0, space);
}

/** `null` bila sah; pesan penolakan bila tidak. */
function rejectionFor(raw: string): string | null {
  const command = raw.trim();
  if (!command.startsWith("/")) {
    return `"${raw}" is not a slash command -- it must start with "/".`;
  }
  if (command === "/") return `"${raw}" is not a slash command -- it has no name.`;
  const telegramOnly = TELEGRAM_ONLY[nameOf(command)];
  if (telegramOnly !== undefined) {
    return `"${nameOf(command)}" is a Telegram-layer command, not a Claude Code one. ${telegramOnly}`;
  }
  return null;
}

export function buildSlashPayload(input: SlashSendInput): SlashSendResult {
  const hasSingle = input.command !== undefined;
  const hasBatch = input.commands !== undefined;

  // Menolak "keduanya" alih-alih memilih salah satu diam-diam: sebuah tool yang
  // mengabaikan separuh argumennya terlihat persis seperti tool yang menuruti
  // keduanya, dan bedanya baru terasa saat perintah yang hilang dibutuhkan.
  if (hasSingle === hasBatch) {
    return {
      ok: false,
      message: "Pass exactly one of `command` or `commands`, not both and not neither.",
    };
  }

  if (hasSingle) {
    const rejection = rejectionFor(input.command!);
    if (rejection !== null) return { ok: false, message: rejection };
    const command = input.command!.trim();
    return {
      ok: true,
      payload: { command },
      ack: `queued "${command}" -- the wrapper injects it on its next tick`,
    };
  }

  const commands = input.commands!;
  if (commands.length === 0) {
    return { ok: false, message: "`commands` is empty -- there is nothing to send." };
  }
  if (commands.length > MAX_SLASH_BATCH) {
    return {
      ok: false,
      message: `A batch may hold at most ${MAX_SLASH_BATCH} commands (got ${commands.length}).`,
    };
  }
  for (const raw of commands) {
    const rejection = rejectionFor(raw);
    // Seluruh batch ditolak, bukan item cacatnya dibuang: batch ADA supaya
    // urutannya utuh, dan urutan yang kehilangan satu langkah lebih berbahaya
    // daripada batch yang tidak pernah berangkat.
    if (rejection !== null) return { ok: false, message: rejection };
  }

  return {
    ok: true,
    payload: commands.map((c) => ({ command: c.trim() })),
    ack:
      `queued ${commands.length} commands as one atomic batch -- ` +
      `no other payload can interleave between them`,
  };
}
