import { extname, isAbsolute, basename } from "node:path";

// Yang Telegram tampilkan inline dengan preview. Sisanya dikirim apa adanya
// sebagai dokumen -- tanpa kompresi, nama berkas tetap terbaca.
export const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** Batas Telegram untuk sendPhoto. Di atas ini gambar tetap dikirim, sebagai dokumen. */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/** Batas Telegram untuk sendDocument. Di atas ini tidak ada yang bisa dilakukan. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

export type PlannedAttachment = {
  path: string;
  kind: "photo" | "document";
  bytes: number;
};

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// Batasnya ditulis bulat, ukuran nyatanya satu desimal. Kalau keduanya dibulatkan
// sama, berkas 50 MB lebih satu byte menghasilkan "50.0MB, max 50.0MB" -- pesan
// yang membuat user mengira batasnya salah, bukan berkasnya kebesaran.
const ATTACHMENT_MAX_MB = Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024);

/**
 * Memvalidasi dan mengklasifikasi SELURUH berkas sebelum satu pun terkirim.
 *
 * Melempar pada masalah pertama, dan itu disengaja: kalau path ketiga salah
 * ketik, user tidak boleh berakhir dengan dua berkas terkirim dan sebuah error.
 * `sizeOf` disuntik supaya seluruh aturan di bawah bisa diuji tanpa filesystem.
 */
export function planAttachments(
  files: string[],
  sizeOf: (path: string) => number
): PlannedAttachment[] {
  return files.map((path) => {
    if (!isAbsolute(path)) {
      throw new Error(
        `attachment path must be absolute (relative paths resolve against the MCP process cwd, not yours): ${path}`
      );
    }

    let bytes: number;
    try {
      bytes = sizeOf(path);
    } catch {
      throw new Error(`attachment not found: ${path}`);
    }

    if (bytes > ATTACHMENT_MAX_BYTES) {
      throw new Error(
        `attachment too large: ${basename(path)} (${mb(bytes)}, max ${ATTACHMENT_MAX_MB}MB)`
      );
    }

    // Gambar raksasa turun kelas, bukan ditolak: Telegram menolak sendPhoto di
    // atas 10 MB, dan yang hilang dengan mengirimnya sebagai dokumen cuma
    // preview inline. Nol dari 110 kiriman historis pernah menyentuh angka ini
    // -- tambalannya dipasang karena harganya satu percabangan, bukan karena
    // pernah terjadi.
    const isPhoto = PHOTO_EXTS.has(extname(path).toLowerCase()) && bytes <= PHOTO_MAX_BYTES;
    return { path, kind: isPhoto ? "photo" : "document", bytes };
  });
}
