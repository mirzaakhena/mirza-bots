/**
 * Mengenali apakah sebuah pesan Telegram adalah slash Telegram, dan yang mana.
 * Murni: menerima teks, mengembalikan keputusan.
 *
 * Daftar "dikenal" sengaja PENDEK (spec §4). Yang di luar daftar tidak
 * ditolak -- ia lewat jalur konfirmasi tombol, jadi mencoret sesuatu dari
 * daftar tidak menghilangkan kemampuannya, hanya menambah satu tap.
 *
 * Tahap ini hanya /rename dan /new. /switch dan /context butuh barang yang
 * belum ada (daftar sesi bernama, jembatan statusline) dan punya rencana
 * sendiri.
 */
export const KNOWN_COMMANDS = ["/rename", "/new"] as const;

export type Classified =
  | { kind: "known"; name: string; arg: string }
  | { kind: "unknown"; command: string }
  | { kind: "not-slash" };

export function classify(text: string): Classified {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.length < 2) return { kind: "not-slash" };

  // Pisah pada whitespace pertama: nama command, sisanya argumen. Nama
  // dinormalkan huruf kecil; argumen TIDAK -- nama sesi milik user, dan
  // "Sesi-Besar" tidak boleh diam-diam jadi "sesi-besar".
  const spaceAt = trimmed.search(/\s/);
  const rawName = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  const arg = spaceAt === -1 ? "" : trimmed.slice(spaceAt).trim();
  const name = rawName.toLowerCase();

  // Cocokkan pada KATA perintahnya saja: /renamer bukan /rename.
  if ((KNOWN_COMMANDS as readonly string[]).includes(name)) {
    return { kind: "known", name, arg };
  }
  return { kind: "unknown", command: trimmed };
}
