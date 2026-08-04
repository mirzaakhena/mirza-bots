/**
 * Menentukan statusline mana yang WAJIB dipanggil bridge sesudah ia menangkap.
 * Murni.
 *
 * Sistem lama gagal PERSIS di sini, dan biayanya statusline user hilang di enam
 * dari enam bot harian: installer-nya hanya melihat lapisan project, padahal
 * statusline user tinggal di lapisan global. Yang ditemukan `null`, lalu `null`
 * itu ditulis sebagai string kosong -- dan sejak saat itu tidak ada lagi yang
 * memanggil statusline aslinya.
 *
 * Urutan project-lalu-user di sini bukan selera: ia MENIRU resolusi Claude
 * Code, yang memberi project presedens atas user untuk key yang sama. Bridge
 * menggantikan siapa pun yang efektif terpasang, jadi ia harus tahu persis
 * siapa itu.
 */
export type ChainResult =
  /** Tidak ada statusline sebelumnya. Bridge boleh dipasang tanpa rantai. */
  | { kind: "none" }
  /** Ada, dan inilah yang harus dipanggil bridge sesudah menangkap. */
  | { kind: "found"; command: string }
  /** Bridge versi ini sudah terpasang. Tidak ada yang perlu dikerjakan. */
  | { kind: "already-bridge" }
  /**
   * Yang terpasang bridge kita, tapi versi LAIN. Path-nya perlu diperbarui --
   * dan rantainya TIDAK boleh disentuh, karena statusline user yang asli sudah
   * tersimpan di sana sejak pemasangan pertama.
   */
  | { kind: "stale-bridge" };

function commandOf(statusLine: unknown): string | null {
  if (typeof statusLine !== "object" || statusLine === null || Array.isArray(statusLine)) {
    return null;
  }
  const c = (statusLine as { command?: unknown }).command;
  // String kosong PERSIS yang tertulis di keenam bot sistem lama. Ia berarti
  // "tidak ada", bukan "command bernama kosong".
  if (typeof c !== "string" || c.trim() === "") return null;
  return c;
}

/**
 * Apakah perintah ini bridge KITA, versi apa pun.
 *
 * Perlu ada karena perintah bridge menyematkan NOMOR VERSI di path-nya
 * (`…/cc-plugin/0.10.0/bin/statusline-bridge.ts`) dan versinya berubah tiap
 * rilis. Terukur hidup 2026-08-04: perbandingan string persis membuat bridge
 * versi lama terbaca sebagai "statusline pendahulu yang harus diselamatkan",
 * dan menulisnya ke rantai akan MENGHAPUS statusline user yang asli --
 * menggantinya dengan bridge yang memanggil bridge.
 *
 * Polanya sengaja spesifik (folder plugin + nama berkas persis), bukan sekadar
 * mencari kata "statusline": statusline milik orang lain boleh saja bernama
 * mirip, dan menyangkanya milik kita justru membuang punya user.
 */
function isOurBridge(command: string): boolean {
  const p = command.replace(/\\/g, "/").toLowerCase();
  return p.includes("/cc-plugin/") && p.includes("/bin/statusline-bridge.ts");
}

export function resolveChain(
  projectStatusLine: unknown,
  userStatusLine: unknown,
  bridgeCommand: string
): ChainResult {
  // DUA lapisan. Menghapus salah satunya mengembalikan bug lamanya, dan ada
  // test yang jatuh kalau itu terjadi.
  const effective = commandOf(projectStatusLine) ?? commandOf(userStatusLine);
  if (effective === null) return { kind: "none" };
  if (effective === bridgeCommand) return { kind: "already-bridge" };
  if (isOurBridge(effective)) return { kind: "stale-bridge" };
  return { kind: "found", command: effective };
}
