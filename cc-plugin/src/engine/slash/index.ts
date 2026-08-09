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
import { validateSessionName } from "./session-name";
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

export type SlashDeps = {
  botHome: string;
  newId: () => string;
  /**
   * Nama sesi yang sudah dipakai -- dipakai `/branch` untuk menolak nama
   * bentrok. Sebuah FUNGSI, bukan array: daftarnya dibaca dari disk dan hanya
   * satu cabang di sini yang membutuhkannya, jadi jalur lain tidak boleh ikut
   * membayar pembacaan itu.
   */
  sessionTitles: () => string[];
};

/** `handleConfirm` tidak pernah butuh daftar sesi -- ia meneruskan apa adanya. */
export type ConfirmDeps = Pick<SlashDeps, "botHome" | "newId">;

/** Prefiks tombol "Kirim". Dihitung: 9 byte. */
export const SLASH_CALLBACK_GO = "slash:go:";
/** Tombol "Batal". Tidak membawa muatan apa pun. */
export const SLASH_CALLBACK_CANCEL = "slash:no";
/**
 * Prefiks tombol pindah sesi di bawah pohon `/branch`. Dihitung: 9 byte + UUID
 * 36 = 45, lega di bawah batas 55 -- jadi id sesi dibawa UTUH. Membawa
 * potongan 8 hex akan menghemat byte yang tidak perlu dihemat dan menukarnya
 * dengan kemungkinan salah sesi.
 */
export const SLASH_CALLBACK_SWITCH = "slash:sw:";

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
): { kind: "go"; command: string } | { kind: "cancel" } | { kind: "switch"; sessionId: string } | null {
  if (data === undefined) return null;
  if (data === SLASH_CALLBACK_CANCEL) return { kind: "cancel" };
  if (data.startsWith(SLASH_CALLBACK_SWITCH)) {
    return { kind: "switch", sessionId: data.slice(SLASH_CALLBACK_SWITCH.length) };
  }
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

  // `/branch` juga duduk di sini, bukan di mapKnown, karena dua cabangnya
  // butuh hal yang mapKnown sengaja tidak punya: bentuk polosnya dijawab dari
  // disk (pohon sesi), dan bentuk bernamanya perlu tahu nama apa saja yang
  // sudah dipakai. mapKnown murni dan harus tetap begitu.
  if (c.name === "/branch") {
    // Polos BUKAN kesalahan: itu pertanyaan "saya di mana, ada cabang apa?",
    // dan pertanyaan itu justru paling sering muncul tepat saat orang
    // mengetik /branch. Dijawab, bukan dimarahi.
    if (c.arg === "") return { kind: "local", command: "/branch" };

    const v = validateSessionName(c.arg);
    if (!v.ok) return { kind: "error", message: v.message };

    // Claude Code memakai nama yang kita berikan APA ADANYA -- ia hanya
    // menambahkan "(Branch n)" kalau namanya TIDAK diberikan (terukur
    // 2026-08-09). Jadi tanpa pagar ini, dua sesi bisa bernama sama, dan
    // picker /switch jadi ambigu justru saat ia paling dibutuhkan.
    if (deps.sessionTitles().includes(v.name)) {
      return {
        kind: "error",
        message:
          `Nama \`${v.name}\` sudah dipakai sesi lain. ` +
          `Pakai nama lain supaya dua sesi tidak bernama sama.`,
      };
    }

    writePending(slashDirIn(deps.botHome), { command: `/branch ${v.name}` }, deps.newId());
    return { kind: "sent", ack: `🌿 Branch baru: \`${v.name}\`` };
  }

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
export function handleConfirm(command: string, deps: ConfirmDeps): SlashOutcome {
  writePending(slashDirIn(deps.botHome), { command }, deps.newId());
  return { kind: "sent", ack: `📤 \`${command}\` dikirim ke Claude Code` };
}

/**
 * Tap tombol pindah sesi di bawah pohon `/branch`.
 *
 * Diterjemahkan jadi `/resume <id>` -- perintah Claude Code yang memang ada,
 * disuntik ke sesi yang SEDANG hidup. Tidak ada tipe payload baru di wrapper:
 * bagian paling berisiko dari `/switch` sistem lama justru tidak perlu dibawa.
 *
 * Ack-nya menyebut id-nya, bukan nama sesinya: nama dibaca dari transcript dan
 * bisa saja berubah antara pohon digambar dan tombol ditekan, sedangkan id
 * tidak pernah. Menyebut nama yang sudah basi lebih buruk daripada menyebut id.
 */
export function handleSwitch(sessionId: string, deps: ConfirmDeps): SlashOutcome {
  writePending(slashDirIn(deps.botHome), { command: `/resume ${sessionId}` }, deps.newId());
  return { kind: "sent", ack: `↩️ Pindah ke sesi \`${sessionId.slice(0, 8)}\`` };
}
