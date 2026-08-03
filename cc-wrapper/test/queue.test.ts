import { test, expect, describe } from "bun:test";
import { InjectionQueue, MIN_INJECTION_GAP_MS } from "../src/queue";

describe("InjectionQueue", () => {
  test("antrean kosong tidak mengembalikan apa-apa", () => {
    const q = new InjectionQueue();
    expect(q.next(1000)).toBe(null);
  });

  test("item pertama boleh langsung jalan", () => {
    const q = new InjectionQueue();
    q.enqueue({ command: "/compact" });
    expect(q.next(1000)?.command).toBe("/compact");
  });

  test("item kedua ditahan sampai jarak minimum lewat", () => {
    const q = new InjectionQueue();
    q.enqueue({ command: "/a" });
    q.enqueue({ command: "/b" });
    const first = q.next(1000);
    expect(first?.command).toBe("/a");
    q.markDispatched(500, 1000); // rencana makan 500ms, dikirim pada t=1000

    // Belum boleh: 1000 + 500 + gap belum lewat.
    expect(q.next(1200)).toBe(null);
    expect(q.next(1000 + 500 + MIN_INJECTION_GAP_MS - 1)).toBe(null);
    // Tepat setelah jendela lewat, giliran /b.
    expect(q.next(1000 + 500 + MIN_INJECTION_GAP_MS)?.command).toBe("/b");
  });

  test("urutan FIFO dipertahankan", () => {
    const q = new InjectionQueue();
    q.enqueue({ command: "/1" });
    q.enqueue({ command: "/2" });
    q.enqueue({ command: "/3" });
    expect(q.size()).toBe(3);
    expect(q.next(0)?.command).toBe("/1");
    q.markDispatched(0, 0);
    expect(q.next(MIN_INJECTION_GAP_MS)?.command).toBe("/2");
  });

  // Batch dienqueue berdampingan: tidak ada payload asing boleh menyelip di
  // antara item-itemnya.
  test("batch masuk berdampingan meski ada enqueue lain di antaranya", () => {
    const q = new InjectionQueue();
    q.enqueue({ command: "/x" });
    q.enqueueBatch("b1", [{ command: "/clear" }, { command: "/rename baru" }]);
    q.enqueue({ command: "/y" });

    const order: string[] = [];
    let now = 0;
    for (let i = 0; i < 4; i++) {
      const item = q.next(now);
      expect(item).not.toBe(null);
      order.push(item!.command);
      q.markDispatched(0, now);
      now += MIN_INJECTION_GAP_MS;
    }
    expect(order).toEqual(["/x", "/clear", "/rename baru", "/y"]);
  });

  test("item terakhir batch ditandai", () => {
    const q = new InjectionQueue();
    q.enqueueBatch("b1", [{ command: "/a" }, { command: "/b" }]);
    const first = q.next(0);
    expect(first?.lastOfBatch).toBe(false);
    q.markDispatched(0, 0);
    const second = q.next(MIN_INJECTION_GAP_MS);
    expect(second?.lastOfBatch).toBe(true);
    expect(second?.batchId).toBe("b1");
  });
});
