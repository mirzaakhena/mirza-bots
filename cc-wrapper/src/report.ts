/**
 * Bunyi baris log untuk kegagalan yang TIDAK boleh diam.
 *
 * Lahir dari temuan 2026-08-07: penguras antrean memakai
 * `void runPlan(...).finally(() => dispatching = false)`. `.finally` itu benar
 * dan wajib -- ia yang membuat dispatch gagal tidak mengunci antrean permanen
 * (PTY-063). Yang salah adalah ketiadaan `.catch` di sebelahnya: kalau
 * `pty.write()` melempar, perintah slash user lenyap **tanpa satu jejak pun**.
 *
 * Bentuk kegagalan itu yang paling mahal di proyek ini, dan sudah berkali-kali
 * terbukti: yang tidak meninggalkan jejak tidak bisa diukur, dan yang tidak
 * bisa diukur tidak akan pernah dicari sampai ada yang kebetulan menemukannya.
 *
 * Murni supaya bunyinya bisa dites tanpa PTY: yang perlu dijaga bukan bahwa
 * "ada log", melainkan bahwa lognya menyebut PERINTAH MANA yang hilang. Log
 * yang cuma memuat pesan error menyuruh pembacanya menebak sisanya.
 */
export function describeDispatchFailure(command: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `[cc-wrapper] injeksi GAGAL untuk "${command}": ${reason}`;
}
