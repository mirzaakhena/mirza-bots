/**
 * Validasi nama sesi. Murni.
 *
 * Nama ini berakhir sebagai argumen slash CC yang DIKETIK ke TUI, jadi
 * batasannya bukan soal selera: newline akan terbaca sebagai Enter dan
 * memotong perintah di tengah, meninggalkan separuh nama sebagai prompt.
 */
export const MAX_SESSION_NAME_LENGTH = 120;

export function validateSessionName(
  raw: string
): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim();
  if (name.length === 0) {
    return { ok: false, message: "Butuh nama sesi. Contoh: /rename task-audit" };
  }
  if (/[\r\n]/.test(name)) {
    return {
      ok: false,
      message: "Nama sesi tidak boleh memuat baris baru -- ia diketik langsung ke Claude Code.",
    };
  }
  if (name.length > MAX_SESSION_NAME_LENGTH) {
    return {
      ok: false,
      message: `Nama sesi terlalu panjang (${name.length} karakter, maksimum ${MAX_SESSION_NAME_LENGTH}).`,
    };
  }
  return { ok: true, name };
}
