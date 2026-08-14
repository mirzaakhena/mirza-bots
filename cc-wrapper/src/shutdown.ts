/**
 * Mematikan sesi CC saat wrapper-nya berhenti — dan mengenali saat terminal
 * yang memilikinya sudah tidak ada.
 *
 * Kenapa modul ini perlu ada sama sekali:
 *
 * Di POSIX, terminal yang hilang mengirim SIGHUP ke seluruh process group dan
 * semuanya rontok bersama. **Windows tidak punya padanan itu.** Anak hanya
 * mencatat NOMOR induknya; nomor bukan tali. Induk mati, anaknya jalan terus
 * tanpa sinyal apa pun.
 *
 * Diukur 2026-08-13 (probe stdin, lihat PROBE.md §Yatim): sebuah proses Node
 * yang induknya dibunuh paksa TIDAK menerima `end`, `close`, `error` di stdin,
 * dan tidak menerima satu sinyal pun. Ia hidup terus tanpa gejala. Jadi
 * "deteksi stdin tertutup" — tebakan pertama yang wajar — memang tidak bisa
 * dipakai, dan jangan dicoba lagi.
 *
 * Yang TERBUKTI bekerja di probe yang sama: `process.kill(ownerPid, 0)`
 * mengenali induk yang hilang dalam waktu di bawah satu detik. Mekanisme yang
 * sama sudah dipakai `lock.ts` untuk mengenali pemegang lock yang mati, jadi
 * ini bukan alat baru — cuma dipakai untuk pertanyaan kedua.
 *
 * Yang TIDAK diselesaikan modul ini, supaya tidak disangka selesai: kalau
 * wrapper sendiri dibunuh dengan `taskkill /F`, tidak ada kode kita yang
 * berjalan, jadi sesi CC tetap yatim. Satu-satunya jaminan penuh di Windows
 * adalah Job Object (`KILL_ON_JOB_CLOSE`), dan itu butuh native binding.
 */

/** Berapa pembacaan "pemilik hilang" berturut-turut sebelum wrapper menyerah. */
export const OWNER_MISS_THRESHOLD = 2;

/**
 * Baca PID pemilik dari env. Mengembalikan `null` berarti **watchdog tidak
 * aktif**, dan itu keadaan default yang disengaja: bot yang sengaja dilepas
 * dari terminal tidak boleh bunuh diri hanya karena tidak ada yang mengaku
 * memilikinya. Fitur ini menyala hanya kalau ada yang menyalakannya.
 */
export function parseOwnerPid(raw: string | undefined, selfPid: number): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  // `parseInt` menerima "12abc"; di sini itu salah ketik, bukan PID.
  if (!/^-?\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  // 0 berarti "seluruh process group" di POSIX, 1 adalah init: dua-duanya arah
  // salah yang mahal. Diri sendiri berarti watchdog yang tidak pernah menyala.
  if (pid <= 1 || pid === selfPid) return null;
  return pid;
}

export type OwnerWatchState = { consecutiveMisses: number };

/**
 * Satu langkah watchdog. Murni: pemanggilnya yang tahu cara bertanya apakah
 * sebuah PID masih hidup, dan cara mematikan sesi.
 *
 * Diambangkan, bukan langsung: harga false positive di sini adalah sesi kerja
 * user yang dibunuh, jadi satu pembacaan meleset saja tidak boleh cukup.
 */
export function stepOwnerWatch(
  state: OwnerWatchState,
  ownerAlive: boolean,
  threshold: number = OWNER_MISS_THRESHOLD
): { state: OwnerWatchState; shutdown: boolean } {
  if (ownerAlive) return { state: { consecutiveMisses: 0 }, shutdown: false };
  const consecutiveMisses = state.consecutiveMisses + 1;
  return { state: { consecutiveMisses }, shutdown: consecutiveMisses >= threshold };
}

/**
 * Matikan PTY tanpa pernah melempar.
 *
 * Dipanggil dari `process.on("exit")`, dan apa pun yang melempar di sana
 * menutupi exit code sebenarnya — kegagalan yang menyamar jadi kegagalan lain.
 * PTY yang sudah mati duluan adalah keadaan normal, bukan kesalahan.
 */
export function killQuietly(target: { kill: () => void } | undefined): void {
  if (!target) return;
  try {
    target.kill();
  } catch {
    /* sudah mati, atau handle-nya sudah tertutup — dua-duanya tidak apa-apa */
  }
}
