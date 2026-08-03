import { commonMarkToMarkdownV2 } from "./markdown";

/** Batas keras Telegram untuk satu pesan teks. */
export const TELEGRAM_MAX_CHARS = 4096;

/**
 * Jendela pemotongan untuk CommonMark MENTAH.
 *
 * Setengah dari batas keras, karena escaping MarkdownV2 membengkakkan teks dan
 * seberapa besar bengkaknya tidak bisa diketahui sebelum dikonversi. Margin ini
 * bukan tempat kebenarannya berdiri -- verifikasi per-potongan di planParts()
 * yang menjaga itu.
 *
 * Terukur, bukan diperkirakan: pada inflasi tepat 2x (potongan berisi tanda
 * baca yang semuanya harus di-escape) potongan mentah 2048 karakter menjadi
 * 4097 dan MELUAP batas keras setiap kali; tabel markdown terukur ~2.27x.
 * Jadi angka ini TIDAK membuat fallback ke teks polos jadi tak terjangkau --
 * yang menjamin kebenaran tetap verifikasi per-potongan di planParts(), bukan
 * margin ini. Menurunkan angkanya pun tidak akan menghilangkan fallback itu,
 * cuma menggeser seberapa sering ia kena.
 */
export const CHUNK_MARGIN = 2048;

/**
 * Potong CommonMark mentah, memilih batas paragraf ketimbang hitungan karakter.
 *
 * Kandidat batas hanya diterima kalau letaknya melewati setengah jendela. Tanpa
 * syarat itu, satu baris kosong di karakter ke-5 menghasilkan potongan 5
 * karakter, dan jumlah pesan meledak untuk teks yang sama.
 */
export function chunkRaw(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const out: string[] = [];
  let rest = text;
  const half = limit / 2;

  while (rest.length > limit) {
    const para = rest.lastIndexOf("\n\n", limit);
    const line = rest.lastIndexOf("\n", limit);
    const space = rest.lastIndexOf(" ", limit);
    const cut = para > half ? para : line > half ? line : space > half ? space : limit;
    out.push(rest.slice(0, cut));
    // Baris kosong di sambungan sudah jadi batas antar-pesan; membawanya ikut
    // membuat potongan berikutnya mulai dengan baris kosong di layar.
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** Satu pesan Telegram yang siap dikirim. */
export interface OutboundPart {
  /** Yang dikirim ke Telegram. */
  wire: string;
  /** CommonMark aslinya -- ini yang disimpan ke riwayat, bukan `wire`. */
  raw: string;
  /** false berarti dikirim sebagai teks polos, tanpa parse_mode. */
  mv2: boolean;
}

/**
 * Rencanakan pesan-pesan keluar untuk satu balasan.
 *
 * Jalur cepat lebih dulu: kalau konversi utuh muat, kembalikan satu bagian dan
 * jangan potong apa pun. Ini yang terjadi pada ~90% balasan, dan jalurnya
 * sengaja dibuat identik dengan perilaku sebelum chunking ada.
 *
 * Baru kalau tidak muat, teks MENTAH yang dipotong lalu tiap potongan
 * dikonversi sendiri. Urutan ini load-bearing: memotong teks yang SUDAH
 * dikonversi bisa membelah satu entity (`*tebal` terbuka di potongan 1, tertutup
 * di potongan 2) dan Telegram menolak seluruh potongan itu dengan
 * "can't parse entities". Sistem lama menemukan ini di produksi.
 */
export function planParts(text: string): OutboundPart[] {
  const whole = commonMarkToMarkdownV2(text);
  if (whole.length <= TELEGRAM_MAX_CHARS) return [{ wire: whole, raw: text, mv2: true }];

  return chunkRaw(text, CHUNK_MARGIN).map((raw) => {
    const converted = commonMarkToMarkdownV2(raw);
    // Escaping yang membengkak melewati batas: kirim potongan itu apa adanya
    // sebagai teks polos. Jelek, tapi tidak ada yang hilang -- dan "isi lenyap
    // tanpa sepatah kata" adalah kelas kegagalan yang proyek ini paling hindari.
    return converted.length <= TELEGRAM_MAX_CHARS
      ? { wire: converted, raw, mv2: true }
      : { wire: raw, raw, mv2: false };
  });
}
