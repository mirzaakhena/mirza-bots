/**
 * Satu wrapper per folder.
 *
 * Kenapa kebijakannya KEBALIKAN dari `cc-plugin/src/engine/lock.ts`:
 *
 * Keduanya menjaga hal yang sama — "hanya boleh ada satu" — tapi yang mahal
 * kalau hilang berbeda, dan aturannya sama: lindungi yang paling mahal.
 *
 *   cc-plugin : yang mahal = pesan Telegram terbagi acak ke dua poller.
 *               Poller murah dilahirkan ulang, jadi pemegang lama DIBUNUH.
 *   cc-wrapper: yang mahal = sesi Claude Code hidup yang sedang mengerjakan
 *               sesuatu. Membunuhnya berarti membuang pekerjaan user, jadi
 *               pendatang baru DITOLAK.
 *
 * Efek sampingnya menyenangkan: satu folder → satu wrapper → satu sesi → satu
 * cc-plugin → satu poller. Aturan "satu token satu pembaca" jadi dijaga oleh
 * struktur, bukan oleh mekanisme terpisah.
 *
 * Stale lock adalah kegagalan yang paling sering bikin mekanisme seperti ini
 * dibenci: wrapper mati mendadak, berkas lock tertinggal, dan foldernya
 * terkunci selamanya sampai seseorang menghapusnya dengan tangan. Karena itu
 * yang dicatat adalah PID, dan pemegang yang prosesnya sudah tidak ada
 * diambil alih, bukan dihormati.
 */
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LockDeps = {
  isAlive: (pid: number) => boolean;
  /** Hanya dipakai untuk membuktikan di test bahwa kita TIDAK memanggilnya. */
  terminate: (pid: number) => void;
};

export type LockResult = { ok: true } | { ok: false; heldBy: number };

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 memeriksa keberadaan tanpa mengirim apa pun. Melempar kalau
    // prosesnya sudah tidak ada.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireWrapperLock(
  path: string,
  pid: number,
  deps: Partial<LockDeps> = {}
): LockResult {
  const isAlive = deps.isAlive ?? defaultIsAlive;

  try {
    const held = parseInt(readFileSync(path, "utf8").trim(), 10);
    // `held !== pid` penting: proses yang sama menjalankan ulang langkah ini
    // tidak boleh menolak dirinya sendiri.
    if (Number.isInteger(held) && held > 1 && held !== pid && isAlive(held)) {
      return { ok: false, heldBy: held };
    }
  } catch {
    // Tidak ada berkas, atau isinya tidak terbaca: tidak ada yang memegang
    // sejauh yang bisa kita ketahui. Menolak start karena penjaga yang rusak
    // berarti gagal pada hal yang salah — penjaga ini ada untuk melindungi
    // sesi, bukan untuk menghalangi start.
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid));
  return { ok: true };
}

/**
 * Lepaskan lock, tapi hanya kalau masih milik kita: proses yang lebih baru
 * mungkin sudah mengambil alih, dan menghapus klaimnya akan meninggalkan
 * folder tanpa penjaga.
 */
export function releaseWrapperLock(path: string, pid: number): void {
  try {
    const held = parseInt(readFileSync(path, "utf8").trim(), 10);
    if (held === pid) unlinkSync(path);
  } catch {
    // Sudah hilang, atau memang bukan milik kita.
  }
}
