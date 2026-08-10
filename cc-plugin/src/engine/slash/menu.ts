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

/**
 * Teks yang tampil di menu "/" Telegram. Disalin PERSIS dari `menuHint` sistem
 * lama (`plugins/telegram/commands-registry.ts`) supaya user tidak melihat dua
 * bot yang sama berbicara dengan dua suara berbeda saat migrasi berlangsung --
 * dan bahasanya Inggris karena itu yang sudah dipakai enam bot hariannya.
 */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  "/context": "Context window and session info",
  "/rename": "Rename the current session",
  "/new": "Start a fresh named session",
  "/branch": "Branch of this session",
  "/switch": "Switch to another session",
};

export function buildCommandMenu(): BotCommandEntry[] {
  return KNOWN_COMMANDS.map((name) => ({
    // Telegram menolak entri yang memuat "/": payload memakai nama telanjang,
    // dan aplikasinya yang menambahkan garis miring saat menampilkan.
    command: name.slice(1),
    description: COMMAND_DESCRIPTIONS[name] ?? "",
  }));
}

/** Scope `setMyCommands` yang lebih kuat daripada default. */
export type StaleMenuScope = { type: "all_private_chats" } | { type: "chat"; chat_id: number };

/**
 * Scope yang harus DIKOSONGKAN supaya `buildCommandMenu()` benar-benar terlihat.
 * Murni: menghasilkan daftar, tidak memanggil apa pun.
 *
 * Telegram menyimpan daftar command per scope dan yang lebih spesifik MENANG:
 * `chat` > `all_private_chats` > `default`. Karena `setMyCommands` di sini
 * dipanggil TANPA `scope`, ia hanya pernah menyentuh yang paling lemah -- jadi
 * daftar yang benar bisa terdaftar dan tetap tak terlihat selamanya.
 *
 * Yang menaruh sisa di scope kuat adalah sistem lama, dan sengaja: per-chat
 * untuk chat berpasangan (`plugins/telegram/server.ts:162`), `all_private_chats`
 * untuk /start + /help. Sisanya hidup di **server Telegram**, bukan di berkas
 * mana pun di mesin ini -- mengarsipkan state lama tidak bisa menghapusnya, dan
 * reconcile yang tahu caranya (`server.ts:175`) hanya jalan selama plugin lama
 * hidup, yaitu mati persis saat ia dibutuhkan.
 *
 * Terukur di `bot-06` 2026-08-10: scope chat memuat 10 command lama, menu di HP
 * user tidak berubah sedikit pun sesudah migrasi, dan tidak ada satu pun error
 * di mana pun. Karena itu pembersihan ini dilakukan tiap boot dan tidak
 * bergantung pada siapa pun mengingatnya.
 *
 * `all_private_chats` selalu ikut walau `allowFrom` kosong: /start dan /help
 * tinggal di sana tanpa peduli chat mana pun.
 */
export function staleMenuScopes(allowFrom: readonly string[]): StaleMenuScope[] {
  const scopes: StaleMenuScope[] = [{ type: "all_private_chats" }];
  const sudah = new Set<number>();
  for (const raw of allowFrom) {
    // Bukan angka berarti bukan chat id yang pernah dipakai Telegram: dilewati
    // satu-satu, bukan menghentikan sisanya -- satu salah ketik tidak boleh
    // membuat chat lain ikut tidak dibersihkan.
    if (!/^-?\d+$/.test(raw.trim())) continue;
    const chat_id = Number(raw.trim());
    if (sudah.has(chat_id)) continue;
    sudah.add(chat_id);
    scopes.push({ type: "chat", chat_id });
  }
  return scopes;
}
