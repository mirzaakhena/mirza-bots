import { describe, test, expect } from "bun:test";
import { installShutdown, SHUTDOWN_SIGNALS } from "../../src/engine/shutdown";

/**
 * Perekam handler proses. Menggantikan `process.on` supaya seluruh perilakunya
 * bisa diuji tanpa benar-benar mengirim sinyal ke proses test -- yang akan
 * mematikan test runnernya sendiri.
 */
function fakeProcess() {
  const handlers = new Map<string, Array<() => void>>();
  const exits: number[] = [];
  return {
    handlers,
    exits,
    on: (event: string, fn: () => void) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    exit: (code: number) => exits.push(code),
    fire: (event: string) => {
      for (const fn of handlers.get(event) ?? []) fn();
    },
  };
}

describe("installShutdown", () => {
  // Sampai 0.40.0 `Engine.close()` TIDAK PERNAH dipanggil di produksi: main.ts
  // tidak memanggilnya dan tidak ada satu pun handler sinyal di cc-plugin.
  // Akibatnya `releaseBotLock`, `stopInboxScanner`, dan `typing.stopAll` semuanya
  // kode mati, dan `bot.pid` tertinggal basi setiap kali sesi ditutup.
  //
  // Terlihat hidup 2026-08-10 di mirza_01_bot: doctor melaporkan
  // `"pid": 114880, "alive": false`.
  test("mendaftar ke setiap sinyal DAN ke exit", () => {
    const p = fakeProcess();

    installShutdown({ close: () => {}, on: p.on, exit: p.exit });

    for (const sig of SHUTDOWN_SIGNALS) expect(p.handlers.has(sig)).toBe(true);
    // `exit` wajib ikut: di Windows sinyal POSIX tidak selalu benar-benar
    // sampai, jadi jalur keluar yang normal harus tetap membersihkan.
    expect(p.handlers.has("exit")).toBe(true);
  });

  test("sinyal menutup engine lalu keluar dengan kode 0", () => {
    const p = fakeProcess();
    let closed = 0;

    installShutdown({ close: () => closed++, on: p.on, exit: p.exit });
    p.fire("SIGTERM");

    expect(closed).toBe(1);
    expect(p.exits).toEqual([0]);
  });

  // Node MENGGANTIKAN perilaku bawaan begitu sebuah handler sinyal dipasang.
  // Handler yang lupa keluar sendiri membuat proses BERTAHAN HIDUP sesudah
  // diminta berhenti -- kerusakan yang lebih besar daripada yang diperbaiki.
  test("exit dipanggil bahkan ketika close melempar", () => {
    const p = fakeProcess();

    installShutdown({
      close: () => {
        throw new Error("db sudah tertutup");
      },
      on: p.on,
      exit: p.exit,
    });
    p.fire("SIGINT");

    expect(p.exits).toEqual([0]);
  });

  test("close hanya berjalan SEKALI, berapa pun sinyal yang datang", () => {
    // `conversationsDb.close()` dua kali melempar. Dan sinyal memang datang
    // berpasangan: Ctrl+C mengirim SIGINT ke seluruh grup proses, lalu handler
    // exit ikut menyala sesudahnya.
    const p = fakeProcess();
    let closed = 0;

    installShutdown({ close: () => closed++, on: p.on, exit: p.exit });
    p.fire("SIGINT");
    p.fire("SIGTERM");
    p.fire("exit");

    expect(closed).toBe(1);
  });

  test("jalur `exit` TIDAK memanggil process.exit lagi", () => {
    // Prosesnya sudah dalam perjalanan keluar; memanggil exit() di dalam handler
    // exit adalah rekursi yang tidak menambah apa pun.
    const p = fakeProcess();

    installShutdown({ close: () => {}, on: p.on, exit: p.exit });
    p.fire("exit");

    expect(p.exits).toEqual([]);
  });

  test("kegagalan close dilaporkan, tidak ditelan diam-diam", () => {
    const p = fakeProcess();
    const seen: unknown[] = [];

    installShutdown({
      close: () => {
        throw new Error("meledak");
      },
      on: p.on,
      exit: p.exit,
      onError: (err) => seen.push(err),
    });
    p.fire("SIGTERM");

    expect(seen.length).toBe(1);
  });
});
