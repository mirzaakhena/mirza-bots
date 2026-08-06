/**
 * Dua pengumuman yang mesin kirim ke Telegram tanpa diminta: bot baru hidup,
 * dan nama sesi berubah.
 *
 * ## Kenapa "diberi nama baru", bukan "sesi berganti"
 *
 * Usul awalnya "sesi berganti" — user menggantinya 2026-08-06, dan
 * penggantiannya lebih baik. "Sesi berganti" adalah peristiwa MESIN; `/clear`
 * tanpa rename tidak mengubah apa pun dari sisi user (namanya tetap nama
 * warisan, dan user sendiri yang baru saja menekan clear). Mengumumkannya
 * berarti memberi tahu sesuatu yang sudah diketahui.
 *
 * Yang benar-benar perlu diketahui cuma dua: **botnya hidup**, dan **sesinya
 * sekarang bernama apa**. Keduanya menjawab pertanyaan yang sama; yang berbeda
 * cuma pemicunya.
 *
 * ## Efek samping yang membuat desainnya lebih kecil
 *
 * Karena MESIN yang mengumumkan, kewajiban AI memberi tahu user sesudah
 * menamai sesi (0.23.0) menjadi tidak perlu dan dicabut. Satu jalur untuk tiga
 * sumber rename — bot otomatis, `/rename` dari user, `/new` — dan tidak ada
 * lagi kewajiban yang bisa dilupakan AI.
 */
export type SessionNotice =
  | { kind: "start"; name: string | null }
  | { kind: "renamed"; name: string };

export function renderSessionNotice(notice: SessionNotice, botName: string): string {
  if (notice.kind === "renamed") return `✏️ Sesi sekarang: \`${notice.name}\``;

  // Nama yang belum terbaca dikatakan apa adanya. Mengambilnya dari tangkapan
  // lama akan mengulang persis bug yang dibongkar 2026-08-06: sesi baru
  // dilaporkan dengan nama sesi sebelumnya, dan tidak ada yang terlihat gagal.
  return notice.name === null
    ? `🤖 ${botName} hidup — nama sesi belum terbaca`
    : `🤖 ${botName} hidup — lanjut di sesi \`${notice.name}\``;
}

/**
 * Apakah perubahan nama ini layak diumumkan.
 *
 * `null` di kedua sisi punya arti berbeda, dan keduanya menjawab "jangan":
 * nama sekarang yang tidak diketahui berarti tangkapan statusline belum ada —
 * diam sampai ia datang. Catatan yang belum ada berarti bot baru saja lahir,
 * dan pengumuman start sudah menanganinya; mengumumkan lagi di sini membuat
 * satu kejadian menghasilkan dua pesan.
 */
export function shouldNotifyRename(
  currentName: string | null,
  lastNotified: string | null
): boolean {
  if (currentName === null || lastNotified === null) return false;
  return currentName !== lastNotified;
}
