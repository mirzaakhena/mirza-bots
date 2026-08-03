/**
 * Mengubah satu perintah jadi RENCANA tulisan — urutan potongan teks dan jeda
 * sesudahnya. Tidak menulis apa pun sendiri.
 *
 * Dipisah dari PTY supaya seluruh aturan pengetikan bisa diuji sebagai data,
 * tanpa terminal dan tanpa timer. `pty.ts` hanya menjalankan rencana ini.
 */

/**
 * Jeda antara menulis teks perintah dan Enter penutupnya.
 *
 * Menulis `teks + \r` sebagai SATU tulisan membuat picker autocomplete CC
 * menelan Enter-nya (untuk command bernamespace seperti /telegram:foo, picker
 * bertahan sampai input "mengendap"). Dua tulisan terpisah meniru jeda manusia
 * antara mengetik dan menekan Enter, sehingga CC memperlakukan \r sebagai
 * "submit", bukan "pilih dari picker".
 *
 * Angka empiris dari wrapper lama, dan Task 0 melihat picker itu dengan mata
 * sendiri: mengetik "/clear" memunculkan daftar berisi /clear dan
 * /telegram:name-session sebelum Enter dikirim (cc-wrapper/PROBE.md).
 */
export const SUBMIT_DELAY_MS = 250;

/**
 * Satu tulisan panjang ke ConPTY membuat buffer input meluap: aliran membuang
 * karakter TERTUA dan menyisakan yang terbaru, jadi pesan panjang tiba
 * terpotong hanya ekornya. Menulis potongan kecil dengan jeda memberi TUI
 * kesempatan mengosongkan buffer. Angka empiris dari wrapper lama.
 */
export const CHUNK_SIZE = 100;
export const CHUNK_DELAY_MS = 30;

export type WriteStep = {
  /** Teks yang ditulis ke PTY apa adanya. */
  text: string;
  /** Berapa lama menunggu SESUDAH menulis potongan ini. */
  delayAfterMs: number;
};

/**
 * Potong pada code point (Array.from), bukan unit UTF-16, supaya batas potongan
 * tidak pernah membelah surrogate pair — pesan di sini memuat emoji, dan
 * surrogate yang terbelah merusak aliran. join("") selalu menyusun ulang input.
 */
export function chunkText(text: string, size: number = CHUNK_SIZE): string[] {
  const cps = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(""));
  return out.length > 0 ? out : [""];
}

/**
 * Rencana untuk satu slash command.
 *
 * `confirmAfterMs` mengirim Enter KEDUA setelah jeda itu — untuk command yang
 * memunculkan picker konfirmasi dengan pilihan "Yes" sudah tersorot (/effort).
 * Tanpa Enter kedua, picker menggantung.
 */
export function planCommand(
  command: string,
  opts?: { confirmAfterMs?: number }
): WriteStep[] {
  const parts = chunkText(command);
  const steps: WriteStep[] = parts.map((text, i) => ({
    text,
    delayAfterMs: i === parts.length - 1 ? SUBMIT_DELAY_MS : CHUNK_DELAY_MS,
  }));

  const confirm = opts?.confirmAfterMs;
  if (confirm !== undefined && confirm > 0) {
    steps.push({ text: "\r", delayAfterMs: confirm });
    steps.push({ text: "\r", delayAfterMs: 0 });
  } else {
    steps.push({ text: "\r", delayAfterMs: 0 });
  }
  return steps;
}

/** Total waktu rencana ini, dipakai antrean untuk menahan gerbang. */
export function planDurationMs(steps: WriteStep[]): number {
  return steps.reduce((sum, s) => sum + s.delayAfterMs, 0);
}
