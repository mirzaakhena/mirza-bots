import { test, expect, describe } from "bun:test";
import {
  parseOwnerPid,
  stepOwnerWatch,
  killQuietly,
  OWNER_MISS_THRESHOLD,
} from "../src/shutdown";

describe("parseOwnerPid", () => {
  // Watchdog HARUS bisa tidak aktif: bot yang sengaja dijalankan lepas dari
  // terminal (penjadwal, launcher yang langsung keluar) tidak boleh bunuh diri
  // hanya karena tidak ada yang mengaku sebagai pemiliknya.
  test("tanpa env: watchdog mati", () => {
    expect(parseOwnerPid(undefined, 100)).toBe(null);
    expect(parseOwnerPid("", 100)).toBe(null);
    expect(parseOwnerPid("   ", 100)).toBe(null);
  });

  test("nilai bukan angka: watchdog mati, bukan crash", () => {
    expect(parseOwnerPid("bukan-angka", 100)).toBe(null);
    expect(parseOwnerPid("12abc", 100)).toBe(null);
  });

  // PID 0 dan 1 bukan pemilik yang masuk akal, dan `process.kill(0, 0)` di
  // POSIX berarti "seluruh process group" — arah salah yang mahal.
  test("PID tidak masuk akal ditolak", () => {
    expect(parseOwnerPid("0", 100)).toBe(null);
    expect(parseOwnerPid("1", 100)).toBe(null);
    expect(parseOwnerPid("-5", 100)).toBe(null);
  });

  // Menunjuk diri sendiri berarti watchdog menunggu dirinya sendiri mati:
  // tidak pernah menyala, dan menyembunyikan salah pasang di launcher.
  test("PID diri sendiri ditolak", () => {
    expect(parseOwnerPid("100", 100)).toBe(null);
  });

  test("PID wajar diterima", () => {
    expect(parseOwnerPid("4242", 100)).toBe(4242);
    expect(parseOwnerPid(" 4242 ", 100)).toBe(4242);
  });
});

describe("stepOwnerWatch", () => {
  test("pemilik hidup: tidak shutdown", () => {
    const r = stepOwnerWatch({ consecutiveMisses: 0 }, true);
    expect(r.shutdown).toBe(false);
    expect(r.state.consecutiveMisses).toBe(0);
  });

  // Satu pembacaan gagal tidak cukup. Harga false positive di sini adalah sesi
  // kerja user yang dibunuh, jadi ambangnya sengaja lebih dari satu.
  test("hilang sekali: BELUM shutdown", () => {
    const r = stepOwnerWatch({ consecutiveMisses: 0 }, false);
    expect(r.shutdown).toBe(false);
    expect(r.state.consecutiveMisses).toBe(1);
  });

  test("hilang berturut-turut sampai ambang: shutdown", () => {
    let state = { consecutiveMisses: 0 };
    let shutdown = false;
    for (let i = 0; i < OWNER_MISS_THRESHOLD; i++) {
      const r = stepOwnerWatch(state, false);
      state = r.state;
      shutdown = r.shutdown;
    }
    expect(shutdown).toBe(true);
  });

  // Pemilik yang sempat tidak terbaca lalu terbaca lagi bukan pemilik yang
  // hilang; hitungannya harus mulai dari nol lagi.
  test("pemilik muncul lagi: hitungan direset", () => {
    const miss = stepOwnerWatch({ consecutiveMisses: 1 }, true);
    expect(miss.state.consecutiveMisses).toBe(0);
    expect(miss.shutdown).toBe(false);
  });

  test("ambang bisa diatur", () => {
    const r = stepOwnerWatch({ consecutiveMisses: 0 }, false, 1);
    expect(r.shutdown).toBe(true);
  });
});

describe("killQuietly", () => {
  test("memanggil kill", () => {
    let dipanggil = false;
    killQuietly({ kill: () => { dipanggil = true; } });
    expect(dipanggil).toBe(true);
  });

  // Dipakai dari dalam handler `process.on("exit")`: apa pun yang melempar di
  // sana menutupi exit code sebenarnya dan membuat penyebabnya sulit dibaca.
  test("kill yang melempar tidak merembet keluar", () => {
    expect(() =>
      killQuietly({ kill: () => { throw new Error("sudah mati"); } })
    ).not.toThrow();
  });

  test("target kosong tidak melempar", () => {
    expect(() => killQuietly(undefined)).not.toThrow();
  });
});
