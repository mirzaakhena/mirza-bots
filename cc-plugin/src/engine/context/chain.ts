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
  /** Bridge sudah terpasang. Memasang lagi akan membuatnya memanggil dirinya. */
  | { kind: "already-bridge" };

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
  return { kind: "found", command: effective };
}
