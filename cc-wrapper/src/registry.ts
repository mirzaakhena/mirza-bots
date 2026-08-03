/**
 * Perlakuan khusus per-command, berbentuk DATA.
 *
 * Bentuk data dan bukan class hierarchy karena mayoritas slash CC tidak
 * mengubah keadaan sesi sama sekali, jadi tidak punya apa pun untuk ditunggu.
 * Hierarchy akan memaksa struktur ke 100% command padahal yang membutuhkannya
 * sedikit; dengan data, menambah command berarti menambah satu baris.
 *
 * DEFAULT: tidak terdaftar -> ketik + Enter, selesai.
 *
 * Bidang `preCheck`/`postCheck` sengaja BELUM ada di sini: keduanya butuh
 * sumber bukti (hook CC), yang datang di rencana berikutnya. Menambahkannya
 * nanti berarti menambah bidang, bukan membongkar bentuk.
 */
export type CommandSpec = {
  /**
   * Kirim Enter KEDUA setelah jeda ini. Untuk command yang memunculkan picker
   * konfirmasi dengan "Yes" sudah tersorot; tanpa Enter kedua picker
   * menggantung.
   */
  confirmAfterMs?: number;
};

export const COMMAND_SPECS: Record<string, CommandSpec> = {
  "/effort": { confirmAfterMs: 500 },
};

const EMPTY: CommandSpec = {};

/**
 * Cocokkan pada KATA perintahnya saja; argumen diabaikan, dan `/effortless`
 * tidak boleh ikut cocok dengan `/effort` — jebakan yang sama sudah pernah
 * dijaga eksplisit di slash-guards lama.
 */
export function specFor(command: string): CommandSpec {
  const word = command.trim().split(/\s/, 1)[0]?.toLowerCase() ?? "";
  return COMMAND_SPECS[word] ?? EMPTY;
}
