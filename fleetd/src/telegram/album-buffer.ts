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
    private onFlush: FlushHandler<T>
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
  }

  flush(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    clearTimeout(bucket.debounceTimer);
    clearTimeout(bucket.hardCapTimer);
    this.buckets.delete(key);
    this.onFlush(key, bucket.items);
  }
}
