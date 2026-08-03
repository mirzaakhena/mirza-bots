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

/**
 * Jahit ulang fence pagar (```) yang terpotong oleh chunkRaw().
 *
 * W: insiden 2026-08-03 -- tabel markdown 120 baris terbungkus fence dikirim
 * lewat satu reply. chunkRaw() memotongnya di batas paragraf/baris tanpa tahu
 * apa-apa soal fence (dan MEMANG tidak boleh tahu -- lihat komentar di
 * chunkRaw()). Fence pembuka mendarat di potongan 1, fence penutup di
 * potongan 5. Tiap potongan diparse SENDIRI-SENDIRI (constraint yang sama
 * yang memaksa commonMarkToMarkdownV2 dipanggil per-potongan di planParts())
 * -- jadi potongan 5 cuma melihat satu ``` kesepian dan membacanya sebagai
 * PEMBUKA, menelan pertanyaan penutup dan daftar bernomor jadi satu blok
 * kode. Isinya utuh, tapi di HP user tampil monospace dengan tombol "COPY
 * CODE", bukan pertanyaan yang bisa dibaca.
 *
 * Kenapa membuka-ulang, bukan mengajari chunkRaw() menghindari potong-di-
 * dalam-fence: chunkRaw() memilih batas dari panjang karakter mentah saja,
 * tanpa parsing markdown apa pun -- itu yang membuatnya murah dan diuji
 * sendiri (lihat test chunk.test.ts). Mengajarinya soal fence berarti ia
 * harus mem-parse CommonMark buat tahu kapan posisi potong ada di dalam blok
 * kode -- pekerjaan yang sudah dilakukan commonMarkToMarkdownV2 dan sekarang
 * harus diduplikasi cuma buat cari batas potong. Lebih murah dan lebih
 * jelas: biarkan potongannya jatuh di mana pun batas paragraf/baris
 * menaruhnya, lalu jahit tiap potongan supaya berdiri sendiri sebagai
 * CommonMark yang valid -- pembuka yang terbawa ditutup di akhir potongan,
 * dan potongan berikutnya membuka ulang fence yang sama, sehingga isinya
 * tetap tampil sebagai kode di kedua sisi sambungan, bukan tercecer jadi
 * teks polos atau (lebih parah, ini yang terjadi 2026-08-03) menelan konten
 * di luar fence.
 */
export function balanceFences(parts: string[]): string[] {
  let openFence: string | null = null;

  return parts.map((part) => {
    let text = openFence !== null ? `${openFence}\n${part}` : part;

    let scanOpen: string | null = null;
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("```")) {
        scanOpen = scanOpen === null ? line.trim() : null;
      }
    }

    if (scanOpen !== null) text = `${text}\n\`\`\``;

    openFence = scanOpen;
    return text;
  });
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

  return balanceFences(chunkRaw(text, CHUNK_MARGIN)).map((raw) => {
    const converted = commonMarkToMarkdownV2(raw);
    // Escaping yang membengkak melewati batas: kirim potongan itu apa adanya
    // sebagai teks polos. Jelek, tapi tidak ada yang hilang -- dan "isi lenyap
    // tanpa sepatah kata" adalah kelas kegagalan yang proyek ini paling hindari.
    return converted.length <= TELEGRAM_MAX_CHARS
      ? { wire: converted, raw, mv2: true }
      : { wire: raw, raw, mv2: false };
  });
}
