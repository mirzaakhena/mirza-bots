import { expect, test } from "bun:test";
import {
  createTypingKeepalive,
  TYPING_PING_INTERVAL_MS,
  TYPING_MAX_MS,
} from "../../src/engine/typing";

/**
 * Timer palsu: menyimpan callback dan memajukan waktu atas perintah, jadi test
 * tidak pernah menunggu detik sungguhan dan hasilnya tidak bisa flaky.
 */
function fakeClock() {
  let nowMs = 0;
  const timers = new Map<number, { fn: () => void; every: number; next: number }>();
  let nextId = 1;
  return {
    now: () => nowMs,
    setInterval: (fn: () => void, every: number) => {
      const id = nextId++;
      timers.set(id, { fn, every, next: nowMs + every });
      return id;
    },
    clearInterval: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      const target = nowMs + ms;
      // Jalankan tiap tick pada waktunya, bukan sekaligus di akhir: keepalive
      // memutuskan berhenti berdasarkan jam, dan melompati waktu akan
      // menyembunyikan keputusan itu.
      for (;;) {
        let due: { id: number; t: { fn: () => void; every: number; next: number } } | undefined;
        for (const [id, t] of timers) if (t.next <= target && (!due || t.next < due.t.next)) due = { id, t };
        if (!due) break;
        nowMs = due.t.next;
        due.t.next = nowMs + due.t.every;
        due.t.fn();
      }
      nowMs = target;
    },
    live: () => timers.size,
  };
}

test("ping pertama dikirim SEGERA, bukan setelah interval pertama lewat", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const k = createTypingKeepalive({ send: c => void sent.push(c), ...clock });

  k.start("111");
  expect(sent).toEqual(["111"]);
});

test("ping berulang selama keepalive hidup", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const k = createTypingKeepalive({ send: c => void sent.push(c), ...clock });

  k.start("111");
  clock.advance(TYPING_PING_INTERVAL_MS * 3);
  expect(sent.length).toBe(4); // satu segera + tiga tick
});

test("stop menghentikan ping, dan tidak ada yang menyusul sesudahnya", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const k = createTypingKeepalive({ send: c => void sent.push(c), ...clock });

  k.start("111");
  clock.advance(TYPING_PING_INTERVAL_MS);
  const before = sent.length;
  k.stop("111");
  clock.advance(TYPING_PING_INTERVAL_MS * 5);
  expect(sent.length).toBe(before);
  expect(clock.live()).toBe(0);
});

// Dihitung dari LAJU ping, bukan dari jumlah timer: dua timer yang menumpuk
// akan tetap lolos kalau yang diperiksa cuma "ada timer atau tidak".
test("start dua kali pada chat yang sama tidak menumpuk timer", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const k = createTypingKeepalive({ send: c => void sent.push(c), ...clock });

  k.start("111");
  k.start("111");
  sent.length = 0;
  clock.advance(TYPING_PING_INTERVAL_MS * 4);
  expect(sent.length).toBe(4);
});

test("dua chat berjalan sendiri-sendiri", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const k = createTypingKeepalive({ send: c => void sent.push(c), ...clock });

  k.start("111");
  k.start("222");
  sent.length = 0;
  k.stop("111");
  clock.advance(TYPING_PING_INTERVAL_MS * 2);
  expect(sent.every(c => c === "222")).toBe(true);
  expect(sent.length).toBe(2);
});

test("berhenti sendiri setelah batas waktu, supaya indikator tidak nyangkut", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const k = createTypingKeepalive({ send: c => void sent.push(c), ...clock });

  k.start("111");
  clock.advance(TYPING_MAX_MS + TYPING_PING_INTERVAL_MS * 2);
  const after = sent.length;
  clock.advance(TYPING_PING_INTERVAL_MS * 3);
  expect(sent.length).toBe(after);
  expect(clock.live()).toBe(0);
});

test("start lagi memperpanjang batas waktunya, bukan meneruskan yang lama", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const k = createTypingKeepalive({ send: c => void sent.push(c), ...clock });

  k.start("111");
  clock.advance(TYPING_MAX_MS - TYPING_PING_INTERVAL_MS);
  k.start("111");
  sent.length = 0;
  clock.advance(TYPING_PING_INTERVAL_MS * 2);
  expect(sent.length).toBeGreaterThan(0);
});

// Hiasan tidak boleh menjatuhkan apa pun. Kalau satu ping gagal, yang berikutnya
// tetap jalan -- sebuah jaringan yang tersendat sesaat bukan alasan indikator
// mati sampai giliran berakhir.
test("send yang melempar tidak menghentikan keepalive dan tidak merambat keluar", () => {
  const clock = fakeClock();
  let calls = 0;
  const k = createTypingKeepalive({
    send: () => {
      calls++;
      throw new Error("429 boom");
    },
    ...clock,
  });

  expect(() => k.start("111")).not.toThrow();
  clock.advance(TYPING_PING_INTERVAL_MS * 2);
  expect(calls).toBe(3);
});

test("stopAll mematikan semuanya sekaligus", () => {
  const clock = fakeClock();
  const k = createTypingKeepalive({ send: () => {}, ...clock });

  k.start("111");
  k.start("222");
  k.stopAll();
  expect(clock.live()).toBe(0);
});

test("stop pada chat yang tidak berjalan tidak melempar", () => {
  const clock = fakeClock();
  const k = createTypingKeepalive({ send: () => {}, ...clock });
  expect(() => k.stop("tidak-ada")).not.toThrow();
});

test("konstantanya eksplisit, bukan angka telanjang yang tersebar", () => {
  expect(TYPING_PING_INTERVAL_MS).toBe(4_000);
  expect(TYPING_MAX_MS).toBe(300_000);
});
