/**
 * Keputusan seputar menghidupkan CC: argumen apa yang dipakai, dan bagaimana
 * menafsirkan keluarannya. Murni — tidak menyentuh proses maupun disk.
 *
 * ## Kenapa `--continue`, bukan `--resume <id>`
 *
 * Wrapper lama mencari "sesi terakhir" dengan memindai
 * `~/.claude/projects/<folder-ter-encode>/` dan memilih `.jsonl` dengan mtime
 * tertinggi. Itu memaksa wrapper menyalin dua aturan internal Claude Code: di
 * mana berkas sesi disimpan, dan bagaimana nama folder diubah jadi nama
 * direktori. Kalau CC mengubah salah satunya, wrapper lama pecah DIAM-DIAM —
 * ia menemukan nol berkas, menyimpulkan "belum ada sesi", dan memulai sesi
 * baru setiap kali tanpa satu pun pesan galat.
 *
 * `--continue` menyerahkan pertanyaannya ke pihak yang paling berhak menjawab.
 *
 * ## Kenapa butuh percobaan ulang
 *
 * Diukur 2026-08-03 (probe): `claude --continue` di folder yang belum punya
 * sesi menjawab `No conversation found to continue` lalu KELUAR — bukan mulai
 * sesi baru. Folder tanpa sesi bukan kasus langka; itu keadaan pertama setiap
 * bot baru.
 *
 * Jadi: coba `--continue`; kalau CC keluar cepat DAN mengatakan kalimat itu,
 * spawn ulang tanpa flag tersebut. Biayanya satu spawn tambahan, sekali seumur
 * folder — dan wrapper tetap tidak perlu tahu apa pun soal layout internal CC.
 */

export const CONTINUE_FLAG = "--continue";

/** Bentuk pendek `--continue` milik CC; user boleh menuliskannya sendiri. */
const CONTINUE_ALIASES = new Set([CONTINUE_FLAG, "-c"]);

/**
 * Keluaran PTY datang dengan escape sequence dan sering TANPA spasi, karena TUI
 * merender per kolom. Probe menangkap "Quicksafetycheck:Isthisaproject…".
 * Normalisasi membuang keduanya supaya pencocokan tidak bergantung pada
 * bagaimana teks kebetulan terender.
 */
function normalize(s: string): string {
  return s
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B\[[?>!]?[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1B[=>NOM]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** Argumen percobaan pertama: `--continue` di depan, kecuali user sudah menulisnya. */
export function firstAttemptArgs(extraArgs: string[]): string[] {
  const sudahAda = extraArgs.some((a) => CONTINUE_ALIASES.has(a));
  return sudahAda ? [...extraArgs] : [CONTINUE_FLAG, ...extraArgs];
}

/** Argumen percobaan kedua: tanpa `--continue` sama sekali. */
export function retryArgs(extraArgs: string[]): string[] {
  return extraArgs.filter((a) => !CONTINUE_ALIASES.has(a));
}

const NO_CONVERSATION = normalize("No conversation found to continue");

export function looksLikeNoConversation(output: string): boolean {
  return normalize(output).includes(NO_CONVERSATION);
}

const TRUST_GATE = normalize("Quick safety check");

/**
 * Gerbang "apakah kamu memercayai folder ini" muncul SEBELUM CC siap, dan
 * `--dangerously-skip-permissions` TIDAK melewatinya (diuji 2026-08-03).
 * Sesi yang tertahan di sini tidak pernah siap, dan apa pun yang disuntik ke
 * dalamnya hilang atau malah terbaca sebagai pilihan menu.
 *
 * Wrapper hanya MENGENALI dan MELAPOR. Menyuntik Enter di sini berarti
 * memercayai sebuah folder atas nama user tanpa ia melihat isinya — keputusan
 * keamanan, bukan keputusan teknis. Keputusan user 2026-08-03: deteksi dan
 * lapor. **Jangan diam-diam diubah jadi melewati otomatis.**
 */
export function looksLikeTrustGate(output: string): boolean {
  return normalize(output).includes(TRUST_GATE);
}

/**
 * Ambang "keluar cepat". Sesi yang berumur lebih lama dari ini lalu berakhir
 * adalah sesi yang benar-benar dipakai (mis. user mengetik /exit) —
 * menghidupkannya lagi berarti melawan maunya user.
 */
export const FAST_EXIT_MS = 15_000;

export function shouldRetryWithoutContinue(opts: {
  exited: boolean;
  elapsedMs: number;
  output: string;
}): boolean {
  if (!opts.exited) return false;
  if (opts.elapsedMs >= FAST_EXIT_MS) return false;
  // Kegagalan lain (binary tidak ketemu, folder tidak ada) TIDAK boleh memicu
  // percobaan ulang: mengulang akan menyembunyikan sebabnya di balik percobaan
  // kedua yang gagal dengan cara berbeda.
  return looksLikeNoConversation(opts.output);
}
