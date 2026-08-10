/**
 * Menyambungkan `Engine.close()` ke akhir hidup prosesnya.
 *
 * ## Kenapa berkas ini ada
 *
 * Sampai 0.40.0 `Engine.close()` **tidak pernah dipanggil di produksi**.
 * `grep -rn "\.close()"` atas seluruh `src`, `bin`, dan `hooks` hanya menemukan
 * `conversationsDb.close()` DI DALAM `Engine.close()` sendiri; `main.ts` tidak
 * memanggilnya, dan tidak ada satu pun handler sinyal di `cc-plugin`.
 *
 * Yang jadi kode mati karena itu: `releaseBotLock`, `stopInboxScanner`,
 * `typing.stopAll`, `stopSessionAnnouncer`. Gejalanya terlihat hidup 2026-08-10
 * pada `mirza_01_bot` -- doctor melaporkan `"pid": 114880, "alive": false`,
 * yaitu kunci basi yang ditinggalkan sesi yang sudah ditutup. README bahkan
 * menjelaskan keadaan itu seolah luar biasa, padahal ia keadaan NORMAL setiap
 * kali sesi berakhir.
 *
 * ## Kenapa harus memanggil `exit` sendiri
 *
 * Node **menggantikan** perilaku bawaan begitu sebuah handler sinyal dipasang.
 * Handler yang lupa keluar sendiri membuat proses BERTAHAN HIDUP sesudah
 * diminta berhenti -- kerusakan yang lebih besar daripada yang sedang
 * diperbaiki. Karena itu `exit` ada di sini, dan ia disuntik supaya seluruh
 * aturan di bawah bisa diuji tanpa benar-benar mematikan test runner.
 *
 * ## Kenapa `exit` ikut didaftar, bukan cuma sinyal
 *
 * Di Windows sinyal POSIX tidak selalu benar-benar sampai ke proses anak. Jalur
 * keluar yang normal karena itu harus tetap membersihkan. Ini pola yang sama
 * yang sudah dipakai `cc-wrapper/src/main.ts` sejak fondasinya.
 *
 * ## Kenapa hanya SEKALI
 *
 * `conversationsDb.close()` yang dipanggil dua kali melempar. Dan sinyal memang
 * datang berpasangan: Ctrl+C mengirim SIGINT ke seluruh grup proses, lalu
 * handler `exit` menyala sesudahnya. Penjaga sekali-jalan bukan kehati-hatian
 * berlebih, ia jalur harian.
 *
 * ## Kenapa kegagalan `close` tidak boleh menahan `exit`
 *
 * Yang paling mungkin gagal adalah menutup database yang sudah rusak atau
 * terkunci -- dan pada saat itu satu-satunya hal yang masih bisa dilakukan
 * adalah pergi. Kegagalannya DILAPORKAN, tidak ditelan: pembersihan yang gagal
 * diam-diam meninggalkan kunci basi tanpa ada yang tahu kenapa.
 */

/** Sinyal yang diperlakukan sebagai "tutup lalu keluar". */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export type ShutdownDeps = {
  close: () => void;
  on: (event: string, handler: () => void) => void;
  exit: (code: number) => void;
  onError?: (err: unknown) => void;
};

export function installShutdown(deps: ShutdownDeps): void {
  let done = false;
  const closeOnce = (): void => {
    if (done) return;
    done = true;
    try {
      deps.close();
    } catch (err) {
      deps.onError?.(err);
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    deps.on(signal, () => {
      closeOnce();
      deps.exit(0);
    });
  }

  // Tanpa `exit(0)` di sini: prosesnya sudah dalam perjalanan keluar, dan
  // memanggilnya lagi di dalam handler `exit` tidak menambah apa pun.
  deps.on("exit", closeOnce);
}
