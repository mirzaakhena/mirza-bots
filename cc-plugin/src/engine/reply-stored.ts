/**
 * Satu-satunya cara jalur Telegram mengirim pesan yang BUKAN balasan AI.
 *
 * ## Kenapa berkas ini ada
 *
 * Ada dua pintu keluar ke Telegram, dan cuma satu yang punya buku tamu:
 * `engine.reply()` mengirim LALU mencatat lewat `storeOutgoing`, sementara
 * `ctx.reply()` milik grammy dipakai langsung di sepuluh tempat -- ack slash,
 * pesan error, prompt konfirmasi, "❌ Dibatalkan.", dan SELURUH jawaban
 * `/context` -- dan tidak satu pun tercatat.
 *
 * Terukur di `mirza_02_bot` 2026-08-07: `message_id` 1..85, **74 tercatat, 11
 * hilang (12,9%)**. Sembilan dari sebelas persis menempel sesudah sebuah slash
 * (`/context` 6x, `/rename` 3x). Artinya **setiap jawaban `/context` yang
 * pernah bot itu kirim tidak ada di riwayat percakapannya sendiri**.
 *
 * ## Kenapa ini pengulangan, dan itu yang paling penting dibawa
 *
 * Kelas bug yang SAMA sudah pernah ditemukan dan diperbaiki (spec §2.3), dan
 * komentar di `engine.ts` masih berdiri di sebelah kodenya:
 *
 *   "Slash Telegram dicegat SESUDAH pesannya tercatat, tidak sebelum: sistem
 *    lama melakukan sebaliknya dan membuat sepuluh command tidak pernah muncul
 *    di database sama sekali."
 *
 * Perbaikan itu menutup sisi MASUK saja. Sisi KELUAR tidak pernah disentuh --
 * dan komentarnya berbunyi seolah kasusnya sudah selesai. **Perbaikan yang
 * menutup satu arah dari masalah dua arah meninggalkan sesuatu yang lebih
 * berbahaya daripada bugnya: kalimat yang membuat pembaca berikutnya berhenti
 * mencari.** Karena itu pagarnya sekarang sebuah test yang memeriksa
 * `engine.ts` tidak lagi memanggil `ctx.reply` langsung -- komentar tidak
 * menjaga apa pun, test menjaga.
 *
 * ## Urutannya tidak boleh dibalik
 *
 * Kirim dulu, catat sesudahnya, persis seperti `storeOutgoing`: `message_id`
 * hanya ada di jawaban Telegram, dan baris tanpa `message_id` tidak akan pernah
 * bisa dikutip. Mencatat lebih dulu juga akan mencatat pesan yang tidak pernah
 * sampai.
 */
type SendOptions = Record<string, unknown>;

export type ReplyableCtx = {
  reply: (text: string, other?: SendOptions) => Promise<{ message_id: number }>;
};

export async function replyStored(
  ctx: ReplyableCtx,
  store: (messageId: string, text: string) => void,
  text: string,
  other?: SendOptions
): Promise<void> {
  const sent = await ctx.reply(text, other);
  try {
    store(String(sent.message_id), text);
  } catch (err) {
    // TIDAK PERNAH fatal. Pesannya sudah ada di HP user; melempar di sini akan
    // membuat pemanggil mengira pengirimannya gagal lalu mengulanginya, dan
    // user menerima pesan yang sama dua kali demi sebuah baris database.
    console.error(`cc-plugin: pesan terkirim tapi tidak tercatat: ${err}`);
  }
}
