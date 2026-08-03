import { test, expect, describe } from "bun:test";
import { waitForCapture } from "../../../src/engine/context/wait";
import type { CapturedStatus } from "../../../src/engine/context/render";

const DATA: CapturedStatus = { captured_at_ms: 1, payload: { session_id: "abc" } };

function fakeSleep() {
  const calls: number[] = [];
  return { calls, sleep: async (ms: number) => void calls.push(ms) };
}

describe("waitForCapture", () => {
  test("data sudah ada di percobaan pertama -> tidak menunggu sama sekali", async () => {
    const { calls, sleep } = fakeSleep();
    const got = await waitForCapture(() => DATA, { attempts: 5, delayMs: 100, sleep });
    expect(got).toEqual(DATA);
    expect(calls).toHaveLength(0);
  });

  test("data muncul di percobaan ketiga -> mengembalikannya, menunggu dua kali", async () => {
    const { calls, sleep } = fakeSleep();
    let n = 0;
    const got = await waitForCapture(
      () => (++n >= 3 ? DATA : null),
      { attempts: 5, delayMs: 100, sleep }
    );
    expect(got).toEqual(DATA);
    expect(calls).toEqual([100, 100]);
  });

  // Batasnya harus benar-benar mengikat: bot yang menunggu selamanya lebih
  // buruk daripada bot yang bilang "belum ada".
  test("tidak pernah muncul -> null sesudah tepat `attempts` percobaan", async () => {
    const { calls, sleep } = fakeSleep();
    let n = 0;
    const got = await waitForCapture(
      () => {
        n++;
        return null;
      },
      { attempts: 4, delayMs: 50, sleep }
    );
    expect(got).toBeNull();
    expect(n).toBe(4);
    // Jeda hanya DI ANTARA percobaan: 4 percobaan = 3 jeda. Menunggu sesudah
    // percobaan terakhir adalah waktu yang dibuang begitu saja.
    expect(calls).toEqual([50, 50, 50]);
  });

  test("attempts 1 -> sekali coba, tanpa jeda", async () => {
    const { calls, sleep } = fakeSleep();
    const got = await waitForCapture(() => null, { attempts: 1, delayMs: 999, sleep });
    expect(got).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("pembaca yang melempar diperlakukan sebagai belum ada, bukan menjatuhkan", async () => {
    const { sleep } = fakeSleep();
    let n = 0;
    const got = await waitForCapture(
      () => {
        if (++n < 2) throw new Error("berkas terkunci");
        return DATA;
      },
      { attempts: 3, delayMs: 10, sleep }
    );
    expect(got).toEqual(DATA);
  });
});
