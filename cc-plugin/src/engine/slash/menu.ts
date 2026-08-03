/**
 * Daftar command yang didaftarkan ke Telegram lewat `setMyCommands`, supaya
 * mengetik "/" di HP memunculkan menu. Murni: menghasilkan payload, tidak
 * memanggil apa pun.
 *
 * Menu ini **papan nama, bukan dapur**. Telegram hanya menyimpan daftarnya dan
 * tidak tahu apakah command-nya benar-benar bekerja -- mendaftarkan sesuatu
 * yang belum dibangun berarti menjanjikan barang yang tidak ada. Karena itu
 * daftarnya lahir dari `KNOWN_COMMANDS`, sumber yang sama yang memutuskan apa
 * yang dicegat: papan dan dapur tidak bisa berbeda pendapat.
 *
 * Yang di luar daftar tetap bisa dipakai lewat jalur konfirmasi tombol -- ia
 * hanya tidak muncul di menu. Itu memang bedanya "dikenal" dan "bisa".
 */
import { KNOWN_COMMANDS } from "./classify";

/** Bentuk yang diminta Telegram: nama telanjang, tanpa garis miring. */
export type BotCommandEntry = { command: string; description: string };

export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  "/rename": "Ganti nama sesi yang sedang berjalan",
  "/new": "Mulai sesi baru dengan nama",
  "/context": "Pemakaian context, rate limit, dan biaya sesi",
};

export function buildCommandMenu(): BotCommandEntry[] {
  return KNOWN_COMMANDS.map((name) => ({
    // Telegram menolak entri yang memuat "/": payload memakai nama telanjang,
    // dan aplikasinya yang menambahkan garis miring saat menampilkan.
    command: name.slice(1),
    description: COMMAND_DESCRIPTIONS[name] ?? "",
  }));
}
