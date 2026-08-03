/**
 * Menjaga indikator "typing…" Telegram tetap menyala selama bot benar-benar
 * bekerja.
 *
 * KENAPA BERULANG, BUKAN SEKALI
 *
 * Indikator Telegram padam sendiri ~5 detik setelah chat action terakhir.
 * Sistem lama mengirimnya sekali per pesan masuk, dan diukur 2026-08-03 atas
 * 1.044 giliran nyata: 97,6% berlangsung lebih dari 5 detik, mediannya 33.
 * Jadi satu tembakan berarti lima detik "typing…" lalu senyap sepanjang sisa
 * giliran -- persis keluhan yang indikator ini seharusnya obati.
 *
 * KENAPA SEMUA DISUNTIK
 *
 * `send`, timer, dan jam masuk lewat parameter supaya perilakunya bisa diuji
 * tanpa jaringan dan tanpa menunggu detik sungguhan. Test yang menunggu waktu
 * asli akan lambat, dan yang lebih buruk, flaky.
 */

/** Jeda antar chat action. Di bawah masa hidup indikator (~5 detik) supaya tidak pernah ada jeda gelap. */
export const TYPING_PING_INTERVAL_MS = 4_000;

/**
 * Batas aman satu keepalive.
 *
 * Yang dijaga bukan kenyamanan giliran panjang, melainkan indikator yang
 * NYANGKUT: giliran yang mati tanpa pernah memanggil `reply` tidak boleh
 * meninggalkan "typing…" berkedip tanpa akhir. 300 detik duduk tepat di atas
 * p99 giliran nyata (288 detik).
 */
export const TYPING_MAX_MS = 300_000;

export interface TypingDeps {
  send: (chatId: string) => void | Promise<void>;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now?: () => number;
}

export interface TypingKeepalive {
  start(chatId: string): void;
  stop(chatId: string): void;
  stopAll(): void;
}

export function createTypingKeepalive(deps: TypingDeps): TypingKeepalive {
  const setTimer = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearInterval ?? (h => clearInterval(h as ReturnType<typeof setInterval>));
  const now = deps.now ?? (() => Date.now());

  const live = new Map<string, { handle: unknown; until: number }>();

  /**
   * Satu ping, dan tidak pernah lebih dari itu.
   *
   * Kegagalan ditelan di SINI, bukan diserahkan ke pemanggil: chat action bisa
   * gagal karena 429, jaringan, atau user memblokir bot, dan tidak satu pun
   * dari itu boleh menjadi alasan sebuah giliran gagal. Konsekuensi yang
   * diterima sadar: ping yang gagal tidak meninggalkan jejak.
   */
  const ping = (chatId: string): void => {
    try {
      const r = deps.send(chatId);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(() => {});
      }
    } catch {
      // Sengaja kosong; lihat komentar di atas.
    }
  };

  const stop = (chatId: string): void => {
    const entry = live.get(chatId);
    if (!entry) return;
    clearTimer(entry.handle);
    live.delete(chatId);
  };

  return {
    start(chatId: string): void {
      // Ping segera: indikator harus muncul di detik pertama, bukan setelah
      // interval pertama lewat -- empat detik hening di awal adalah persis
      // jendela yang fitur ini ada untuk menutupnya.
      ping(chatId);

      const existing = live.get(chatId);
      if (existing) {
        // Perpanjang, jangan menumpuk. Dua timer pada satu chat menggandakan
        // laju ping tanpa memberi manfaat apa pun.
        existing.until = now() + TYPING_MAX_MS;
        return;
      }

      const until = now() + TYPING_MAX_MS;
      const handle = setTimer(() => {
        const entry = live.get(chatId);
        if (!entry || now() >= entry.until) {
          stop(chatId);
          return;
        }
        ping(chatId);
      }, TYPING_PING_INTERVAL_MS);

      live.set(chatId, { handle, until });
    },

    stop,

    stopAll(): void {
      for (const chatId of [...live.keys()]) stop(chatId);
    },
  };
}
