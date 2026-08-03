/**
 * Antrean FIFO + gerbang jarak-minimum. Murni: waktu SELALU diserahkan dari
 * luar (`now`), sehingga logikanya bisa diuji tanpa timer.
 *
 * Kenapa serialisasi dipegang di sini dan bukan diserahkan ke pemanggil:
 * jaraknya bukan jarak antar-COMMAND melainkan antar-PENGIRIM. Telegram,
 * agent-bus, dan AI-nya sendiri bisa memerintah bersamaan dan tidak satu pun
 * dari mereka tahu yang lain ada — dua pemanggil yang sama-sama sopan tetap
 * bertabrakan karena masing-masing hanya menghitung dirinya sendiri.
 *
 * Batas kecepatan bisa ditulis di rambu tiap jalan; siapa jalan duluan di
 * persimpangan tidak bisa diserahkan ke tiap sopir.
 *
 * Wrapper lama membayar pelajaran ini dengan tiga korban nyata (BUG #3,
 * 2026-06-07): `/rename idle` tertelan, satu `/clear` hilang seluruhnya, dan
 * satu prompt handoff dimakan di tengah `/clear`.
 */

/** Waktu tenang minimum sesudah setiap injeksi sebelum yang berikutnya boleh mulai. */
export const MIN_INJECTION_GAP_MS = 1_500;

export type QueueItem = {
  command: string;
  confirmAfterMs?: number;
  /** Diisi hanya untuk item yang berasal dari sebuah batch. */
  batchId?: string;
  /** True pada item terakhir sebuah batch. */
  lastOfBatch?: boolean;
};

export class InjectionQueue {
  private items: QueueItem[] = [];
  private holdUntil = 0;

  /** Satu perintah lepas. */
  enqueue(item: QueueItem): void {
    this.items.push({ ...item, lastOfBatch: false });
  }

  /**
   * Sekumpulan perintah berurutan, dimasukkan BERDAMPINGAN sehingga tidak ada
   * payload asing bisa menyelip di antaranya.
   */
  enqueueBatch(
    batchId: string,
    items: Array<Omit<QueueItem, "batchId" | "lastOfBatch">>
  ): void {
    items.forEach((it, i) => {
      this.items.push({ ...it, batchId, lastOfBatch: i === items.length - 1 });
    });
  }

  size(): number {
    return this.items.length;
  }

  /**
   * Item berikutnya yang boleh dikirim sekarang, atau null kalau antrean kosong
   * ATAU gerbang masih menahan. Memanggil ini MENGELUARKAN item dari antrean —
   * pemanggil wajib menyusulkan `markDispatched`.
   */
  next(now: number): QueueItem | null {
    if (this.items.length === 0) return null;
    if (now < this.holdUntil) return null;
    return this.items.shift() ?? null;
  }

  /**
   * Catat bahwa sebuah item sudah dikirim: tahan gerbang selama durasi
   * rencananya ditambah jarak minimum.
   */
  markDispatched(durationMs: number, now: number): void {
    this.holdUntil = Math.max(this.holdUntil, now + durationMs + MIN_INJECTION_GAP_MS);
  }
}
