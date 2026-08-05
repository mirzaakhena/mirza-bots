/**
 * Perakitan lapisan slash Telegram.
 *
 * Satu aturan yang mengikat seluruh berkas ini dan tidak boleh dilanggar
 * (spec §2.3): pemanggilnya WAJIB sudah mencatat pesannya ke conversations.db
 * sebelum memanggil fungsi di sini. Sistem lama mencegat sebelum mencatat, dan
 * biayanya nyata -- audit membaca /switch sebagai 0x dipakai padahal 139x.
 */
import { classify } from "./classify";
import { mapKnown } from "./map";
import { writePending } from "./pending";
import { slashDirIn } from "../paths";

export type SlashOutcome =
  /** Bukan slash Telegram: teruskan ke sesi AI seperti biasa. */
  | { kind: "passthrough" }
  /** Payload sudah ditulis; `ack` layak dikirim ke user. */
  | { kind: "sent"; ack: string }
  /**
   * Dikenal, dicegat, tapi TIDAK pernah sampai ke Claude Code -- dijawab dari
   * data lokal (spec tahap 1 §4). Tidak ada payload wrapper yang lahir.
   */
  | { kind: "local"; command: string }
  /** Slash dikenal tapi argumennya tidak sah. */
  | { kind: "error"; message: string }
  /** Slash tak dikenal: minta konfirmasi sebelum disuntik. */
  | { kind: "confirm"; command: string; prompt: string };

export type SlashDeps = { botHome: string; newId: () => string };

/** Prefiks tombol "Kirim". Dihitung: 9 byte. */
export const SLASH_CALLBACK_GO = "slash:go:";
/** Tombol "Batal". Tidak membawa muatan apa pun. */
export const SLASH_CALLBACK_CANCEL = "slash:no";

/**
 * Telegram menolak callback_data di atas 64 byte dengan BUTTON_DATA_INVALID
 * (W-25 di BACKLOG). Prefiks "slash:go:" memakan 9, jadi command yang muat
 * hanya sampai 55 byte. Yang lebih panjang tidak diberi tombol -- lebih baik
 * mengatakan "terlalu panjang" daripada mengirim tombol yang ditolak Telegram
 * dan meninggalkan user menatap pesan tanpa keyboard.
 */
export const MAX_CONFIRM_COMMAND_BYTES = 64 - SLASH_CALLBACK_GO.length;

export function confirmFits(command: string): boolean {
  // BYTE, bukan karakter: satu emoji memakan empat byte, dan menghitung
  // panjang string akan meloloskan command yang ditolak Telegram.
  return Buffer.byteLength(command, "utf8") <= MAX_CONFIRM_COMMAND_BYTES;
}

/**
 * Apakah sebuah callback_data milik lapisan ini, dan yang mana. Murni.
 *
 * `null` berarti bukan milik lapisan ini -- tombol fitur lain harus tetap
 * sampai ke AI seperti sebelumnya.
 */
export function parseSlashCallback(
  data: string | undefined
): { kind: "go"; command: string } | { kind: "cancel" } | null {
  if (data === undefined) return null;
  if (data === SLASH_CALLBACK_CANCEL) return { kind: "cancel" };
  if (data.startsWith(SLASH_CALLBACK_GO)) {
    return { kind: "go", command: data.slice(SLASH_CALLBACK_GO.length) };
  }
  return null;
}

export function handleSlash(text: string, deps: SlashDeps): SlashOutcome {
  const c = classify(text);
  if (c.kind === "not-slash") return { kind: "passthrough" };

  if (c.kind === "unknown") {
    if (!confirmFits(c.command)) {
      return {
        kind: "error",
        message:
          `Command itu terlalu panjang untuk tombol konfirmasi ` +
          `(${Buffer.byteLength(c.command, "utf8")} byte, maksimum ${MAX_CONFIRM_COMMAND_BYTES}).`,
      };
    }
    return {
      kind: "confirm",
      command: c.command,
      prompt: `Kirim \`${c.command}\` ke Claude Code?`,
    };
  }

  // /context tidak punya padanan di Claude Code: ia dijawab dari berkas
  // tangkapan statusline, bukan disuntikkan ke sesi. Ditaruh SEBELUM mapKnown
  // dengan sengaja -- mapKnown menolak command yang dikenal tapi tidak punya
  // pemetaan, dan pagar itu harus tetap berlaku untuk yang lain.
  if (c.name === "/context") return { kind: "local", command: "/context" };

  const m = mapKnown(c.name, c.arg);
  if (!m.ok) return { kind: "error", message: m.message };

  writePending(slashDirIn(deps.botHome), m.payload, deps.newId());
  return { kind: "sent", ack: m.ack };
}

/**
 * Dipanggil sesudah user menekan tombol "Kirim". Command diteruskan APA
 * ADANYA -- lapisan ini tidak mengolahnya. Menerapkan pemetaan di sini akan
 * membuat tombol konfirmasi berbohong soal apa yang dikirim.
 */
export function handleConfirm(command: string, deps: SlashDeps): SlashOutcome {
  writePending(slashDirIn(deps.botHome), { command }, deps.newId());
  return { kind: "sent", ack: `📤 \`${command}\` dikirim ke Claude Code` };
}
