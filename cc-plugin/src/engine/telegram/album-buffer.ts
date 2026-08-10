type FlushHandler<T> = (key: string, items: T[]) => void;

type Bucket<T> = {
  items: T[];
  debounceTimer: ReturnType<typeof setTimeout>;
  hardCapTimer: ReturnType<typeof setTimeout>;
};

export class AlbumBuffer<T> {
  private buckets = new Map<string, Bucket<T>>();

  constructor(
    private debounceMs: number,
    private hardCapMs: number,
    private onFlush: FlushHandler<T>,
    // Telegram's own limit for a media group. Appended as the last parameter so
    // the three existing call sites and tests keep working unchanged.
    private maxItems: number = 10
  ) {}

  add(key: string, item: T): void {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        items: [],
        debounceTimer: setTimeout(() => this.flush(key), this.debounceMs),
        hardCapTimer: setTimeout(() => this.flush(key), this.hardCapMs),
      };
      this.buckets.set(key, bucket);
    } else {
      clearTimeout(bucket.debounceTimer);
      bucket.debounceTimer = setTimeout(() => this.flush(key), this.debounceMs);
    }
    bucket.items.push(item);

    // Size cap on top of the two time caps. Without it an album was bounded only
    // by time, so a malformed or duplicated media group could grow without limit
    // and turn into one enormous message. Overflow starts a fresh bucket under
    // the same key -- a second message, never a dropped photo.
    if (bucket.items.length >= this.maxItems) this.flush(key);
  }

  flush(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    clearTimeout(bucket.debounceTimer);
    clearTimeout(bucket.hardCapTimer);
    this.buckets.delete(key);
    this.onFlush(key, bucket.items);
  }

  /**
   * Membuang semua yang menunggu TANPA memanggil `onFlush` sekali pun.
   *
   * Dipakai `Engine.close()`. Perbedaannya dengan `flush()` adalah seluruh
   * gunanya: `flush` mengirimkan isinya, `stopAll` membatalkannya. Saat engine
   * ditutup, database sudah (atau akan segera) tertutup -- memanggil `onFlush`
   * di sana berarti `deliver()` menulis ke db yang sudah pergi, yaitu
   * `RangeError: Cannot use a closed database`.
   *
   * Konsekuensi yang diterima sadar: album yang tiba di detik terakhir sebelum
   * sesi ditutup HILANG. Itu memang sudah begitu sebelum ini -- prosesnya mati
   * bersama timernya -- jadi yang berubah bukan nasib albumnya, melainkan
   * apakah kepergiannya meninggalkan galat yang membingungkan.
   *
   * Kedua timer dibersihkan, bukan salah satu. Menghentikan debounce saja
   * meninggalkan hard cap menembak beberapa detik kemudian -- bentuk kegagalan
   * yang paling sulit dilacak, karena jarak antara sebab dan gejalanya jauh.
   */
  stopAll(): void {
    for (const bucket of this.buckets.values()) {
      clearTimeout(bucket.debounceTimer);
      clearTimeout(bucket.hardCapTimer);
    }
    this.buckets.clear();
  }
}
