/**
 * Menunggu berkas tangkapan muncul sesudah bridge baru dipasang.
 *
 * Kenapa ini perlu: `statusLine` di-PUSH Claude Code saat ia menggambar baris
 * status. Detik bridge dipasang, CC belum tentu pernah menggambar sekali pun,
 * jadi berkasnya memang belum ada -- bukan karena rusak, melainkan karena
 * meterannya belum sempat berputar. Terukur hidup 2026-08-04: `/context`
 * pertama menjawab "belum ada data", dan berkasnya terisi beberapa detik
 * kemudian tanpa restart apa pun.
 *
 * Sistem lama menutup lubang yang sama dengan `setTimeout` durasi tetap. Di
 * sini yang ditunggu adalah **kejadiannya**, bukan lamanya: menebak durasi
 * berarti terlalu cepat pada mesin sibuk dan membuang waktu pada mesin cepat.
 *
 * Semua sumber ketidakmurnian disuntik (`read`, `sleep`) supaya bisa diuji
 * tanpa berkas dan tanpa benar-benar menunggu.
 */
export type WaitOptions = {
  /** Berapa kali membaca, termasuk pembacaan pertama. Minimal 1. */
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
};

export async function waitForCapture<T>(
  read: () => T | null,
  opts: WaitOptions
): Promise<T | null> {
  const attempts = Math.max(1, opts.attempts);
  for (let i = 0; i < attempts; i++) {
    let got: T | null = null;
    try {
      got = read();
    } catch {
      // Berkas yang sedang ditulis, atau terkunci sesaat, sama artinya dengan
      // "belum ada" -- dan itu justru keadaan yang sedang kita tunggui.
      got = null;
    }
    if (got !== null) return got;
    // Jeda hanya DI ANTARA percobaan. Menunggu sesudah percobaan terakhir
    // adalah waktu yang dibuang: tidak ada lagi yang akan membacanya.
    if (i < attempts - 1) await opts.sleep(opts.delayMs);
  }
  return null;
}
