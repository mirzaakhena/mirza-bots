import { describe, test, expect } from "bun:test";
import { AlbumBuffer } from "../../src/telegram/album-buffer";

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
});
