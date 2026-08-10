import { describe, test, expect } from "bun:test";
import { AlbumBuffer } from "../../../src/engine/telegram/album-buffer";

describe("AlbumBuffer", () => {
  test("groups items added within the debounce window into one flush", async () => {
    const flushed: Array<{ key: string; items: string[] }> = [];
    const buf = new AlbumBuffer<string>(80, 5000, (key, items) => flushed.push({ key, items }));

    buf.add("album-1", "photo1");
    await new Promise((r) => setTimeout(r, 20));
    buf.add("album-1", "photo2");
    await new Promise((r) => setTimeout(r, 20));
    buf.add("album-1", "photo3");

    expect(flushed.length).toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(flushed).toEqual([{ key: "album-1", items: ["photo1", "photo2", "photo3"] }]);
  });

  test("flushes via hard cap even if items keep arriving faster than the debounce window", async () => {
    const flushed: Array<{ key: string; items: string[] }> = [];
    const buf = new AlbumBuffer<string>(200, 500, (key, items) => flushed.push({ key, items }));

    const interval = setInterval(() => buf.add("album-2", "p"), 100);
    await new Promise((r) => setTimeout(r, 700));
    clearInterval(interval);

    expect(flushed.length).toBe(1);
    expect(flushed[0]?.key).toBe("album-2");
    expect(flushed[0]?.items.length).toBeGreaterThanOrEqual(4);
  });

  test("different keys flush independently", async () => {
    const flushed: Array<{ key: string; items: string[] }> = [];
    const buf = new AlbumBuffer<string>(60, 5000, (key, items) => flushed.push({ key, items }));

    buf.add("a", "1");
    buf.add("b", "2");
    await new Promise((r) => setTimeout(r, 100));

    const keys = flushed.map((f) => f.key).sort();
    expect(keys).toEqual(["a", "b"]);
  });

  test("flushes immediately once maxItems is reached, without waiting for the debounce", async () => {
    const flushed: Array<{ key: string; items: string[] }> = [];
    // Long debounce on purpose: if the cap did not fire, nothing would flush
    // within this test's lifetime and the assertion would fail on an empty array.
    const buf = new AlbumBuffer<string>(5000, 60000, (key, items) => flushed.push({ key, items }), 3);

    buf.add("album-cap", "p1");
    buf.add("album-cap", "p2");
    expect(flushed.length).toBe(0);
    buf.add("album-cap", "p3");

    expect(flushed).toEqual([{ key: "album-cap", items: ["p1", "p2", "p3"] }]);
  });

  test("items arriving after a cap flush start a fresh bucket rather than being dropped", async () => {
    const flushed: Array<{ key: string; items: string[] }> = [];
    const buf = new AlbumBuffer<string>(60, 60000, (key, items) => flushed.push({ key, items }), 2);

    buf.add("album-cap", "p1");
    buf.add("album-cap", "p2"); // flushes at the cap
    buf.add("album-cap", "p3");
    await new Promise((r) => setTimeout(r, 120));

    // Telegram itself caps a media group at 10 and splits client-side, so the cap
    // is a malformed-group defence, not the normal path. Overflow items become a
    // SECOND message -- deliberately, because dropping them would lose a photo
    // the user actually sent.
    expect(flushed.map((f) => f.items)).toEqual([["p1", "p2"], ["p3"]]);
  });
});

describe("AlbumBuffer.stopAll (rem yang sebelumnya tidak ada)", () => {
  // Kenapa ini perlu: `Engine.close()` menghentikan typing, announcer, dan
  // pemindai inbox, lalu MENUTUP database. Buffer ini punya dua timer per album
  // (debounce 1,5 dtk dan hard cap 8 dtk) dan tidak ikut dihentikan -- jadi
  // sebuah album yang tiba tepat sebelum sesi ditutup akan memanggil deliver()
  // sesudah dbnya pergi: `RangeError: Cannot use a closed database`.
  //
  // Hari ini tersembunyi karena `close()` memang tidak pernah dipanggil (A-5).
  // Begitu A-5 diperbaiki, ini yang muncul -- jadi keduanya satu paket.
  test("timer yang menunggu tidak pernah jadi flush", async () => {
    const flushed: string[] = [];
    const buf = new AlbumBuffer<string>(60, 5000, (key) => flushed.push(key));

    buf.add("album-1", "p1");
    buf.stopAll();
    await new Promise((r) => setTimeout(r, 120));

    expect(flushed).toEqual([]);
  });

  // Kedua test di bawah ada karena versi PERTAMA-nya lolos untuk alasan yang
  // salah, dan itu ketahuan lewat mutation check: mencabut `clearTimeout` mana
  // pun TIDAK membuatnya merah. Sebabnya `this.buckets.clear()` sendirian sudah
  // cukup membuat `flush()` pulang lebih awal, jadi `onFlush` memang tidak
  // pernah dipanggil -- entah timernya dibersihkan atau tidak.
  //
  // Yang benar-benar dibeli `clearTimeout` baru terlihat kalau ada bucket BARU
  // dengan kunci yang sama sesudahnya: timer basi milik bucket lama akan
  // menembak flush() ke bucket baru itu, dan mengirimnya JAUH lebih cepat dari
  // waktunya. Itu bentuk yang bisa dilihat, jadi itu yang diuji.
  const jeda = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("hard cap basi tidak menembak bucket berikutnya", async () => {
    const flushed: string[][] = [];
    // Debounce sengaja panjang supaya ia tidak pernah ikut bicara di test ini.
    const buf = new AlbumBuffer<string>(60_000, 400, (_k, items) => flushed.push(items));

    buf.add("a", "p1");
    buf.stopAll(); // hard cap milik p1 seharusnya mati di sini

    await jeda(250);
    buf.add("a", "p2"); // bucket baru, hard capnya sendiri jatuh di t=650

    // t=500: timer basi (t=400) sudah lewat, timer yang sah (t=650) belum.
    await jeda(250);
    expect(flushed).toEqual([]);

    await jeda(400);
    expect(flushed).toEqual([["p2"]]);
  });

  test("debounce basi tidak menembak bucket berikutnya", async () => {
    const flushed: string[][] = [];
    const buf = new AlbumBuffer<string>(400, 60_000, (_k, items) => flushed.push(items));

    buf.add("a", "p1");
    buf.stopAll();

    await jeda(250);
    buf.add("a", "p2");

    await jeda(250);
    expect(flushed).toEqual([]);

    await jeda(400);
    expect(flushed).toEqual([["p2"]]);
  });

  test("seluruh album dihentikan, bukan cuma yang pertama", async () => {
    const flushed: string[] = [];
    const buf = new AlbumBuffer<string>(60, 5000, (key) => flushed.push(key));

    buf.add("a", "1");
    buf.add("b", "2");
    buf.add("c", "3");
    buf.stopAll();
    await new Promise((r) => setTimeout(r, 120));

    expect(flushed).toEqual([]);
  });

  test("stopAll di buffer kosong tidak meledak", () => {
    const buf = new AlbumBuffer<string>(60, 5000, () => {});
    expect(() => buf.stopAll()).not.toThrow();
    expect(() => buf.stopAll()).not.toThrow();
  });
});
