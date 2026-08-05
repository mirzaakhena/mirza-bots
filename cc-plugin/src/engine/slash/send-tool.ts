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
 * Perintah lapisan Telegram: DITOLAK di sini, tapi masing-masing dengan
 * kalimat lengkapnya SENDIRI -- bukan prefiks bersama + sufiks. Satu prefiks
 * ("is a Telegram-layer command, not a Claude Code one") tidak cocok untuk
 * keempatnya: `/effort` ADA di Claude Code (lihat `COMMAND_SPECS["/effort"]`
 * di `cc-wrapper/src/registry.ts`), dan `/switch` punya padanan (`/resume
 * <sessionId>`). Pesan ini dibaca AI -- "tidak ada padanan" membuatnya
 * berhenti mencari; kalimat yang benar membuatnya tahu ini keputusan, bukan
 * keterbatasan, dan ia bisa menyampaikannya apa adanya ke user.
 *
 * Keputusan user 2026-08-05 (Telegram): yang benar-benar terpakai sekarang
 * cuma /new, /rename, /context. /switch mungkin dikerjakan nanti (belum
 * sekarang, sengaja); /effort sengaja tidak dibawa ke sistem baru sama
 * sekali. Keempatnya tetap DITOLAK di sini -- yang berubah cuma alasannya.
 */
const TELEGRAM_ONLY: Record<string, string> = {
  "/new":
    '"/new" is a Telegram-layer command, not a Claude Code one. Use a batch instead: ["/clear", "/rename <name>"].',
  "/delete":
    '"/delete" is a Telegram-layer command, not a Claude Code one -- deleting a session is the Telegram user\'s own call to make there, not something to inject from here.',
  "/switch":
    '"/switch" has not been brought into the new system yet -- a deliberate call, not a missing feature. The closest today is Claude Code\'s own "/resume <sessionId>".',
  "/effort":
    '"/effort" exists in Claude Code -- it is intentionally not carried into this system. If you want it, run "/effort" yourself in Claude Code.',
};

export type SlashSendInput = { command?: string; commands?: string[] };

export type SlashSendResult =
  | { ok: true; payload: WrapperPayload; ack: string }
  | { ok: false; message: string };

/**
 * Nama perintah = kata pertama, dipotong pada whitespace APA PUN (bukan cuma
 * spasi) dan dihuruf-kecilkan. Disamakan dengan saudaranya --
 * `classify.ts` dan `cc-wrapper/src/registry.ts` -- yang keduanya memakai
 * bentuk ini, dan dengan pagar lama yang berkas ini gantikan. Pagar yang
 * lebih longgar dari pagar lama adalah regresi: `/NEW sesi-x` atau
 * `/new<TAB>sesi-x` harus tetap ditolak, bukan lolos karena hanya spasi biasa
 * yang dicek atau huruf besar tidak dinormalkan.
 */
function nameOf(command: string): string {
  return command.trim().split(/\s/, 1)[0]!.toLowerCase();
}

/** `null` bila sah; pesan penolakan bila tidak. */
function rejectionFor(raw: string): string | null {
  const command = raw.trim();
  if (!command.startsWith("/")) {
    return `"${raw}" is not a slash command -- it must start with "/".`;
  }
  if (command === "/") return `"${raw}" is not a slash command -- it has no name.`;
  const telegramOnly = TELEGRAM_ONLY[nameOf(command)];
  if (telegramOnly !== undefined) return telegramOnly;
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
