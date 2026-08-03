import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWrapperLock, releaseWrapperLock } from "../src/lock";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-wrapper-lock-"));
  lockPath = join(dir, "wrapper.pid");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("acquireWrapperLock", () => {
  test("folder bebas: lock diambil, PID tercatat", () => {
    const r = acquireWrapperLock(lockPath, 4242, { isAlive: () => false });
    expect(r.ok).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe("4242");
  });

  // Kebalikan dari cc-plugin/src/engine/lock.ts, dan itu disengaja: yang mahal
  // di sini adalah sesi CC hidup yang sedang mengerjakan sesuatu, bukan poller
  // yang murah dilahirkan ulang.
  test("pemegang masih hidup: DITOLAK, dan tidak membunuh siapa pun", () => {
    writeFileSync(lockPath, "1234");
    let dibunuh = false;
    const r = acquireWrapperLock(lockPath, 9999, {
      isAlive: (pid) => pid === 1234,
      terminate: () => { dibunuh = true; },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.heldBy).toBe(1234);
    expect(dibunuh).toBe(false);
    // Lock lama tidak boleh ditimpa.
    expect(readFileSync(lockPath, "utf8").trim()).toBe("1234");
  });

  test("pemegang sudah mati: lock diambil alih", () => {
    writeFileSync(lockPath, "1234");
    const r = acquireWrapperLock(lockPath, 9999, { isAlive: () => false });
    expect(r.ok).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe("9999");
  });

  test("berkas lock rusak diperlakukan sebagai bebas", () => {
    writeFileSync(lockPath, "bukan angka");
    const r = acquireWrapperLock(lockPath, 7, { isAlive: () => true });
    expect(r.ok).toBe(true);
  });

  test("PID sendiri di lock tidak menolak diri sendiri", () => {
    writeFileSync(lockPath, "555");
    const r = acquireWrapperLock(lockPath, 555, { isAlive: () => true });
    expect(r.ok).toBe(true);
  });
});

describe("releaseWrapperLock", () => {
  test("melepas lock milik sendiri", () => {
    acquireWrapperLock(lockPath, 111, { isAlive: () => false });
    releaseWrapperLock(lockPath, 111);
    expect(existsSync(lockPath)).toBe(false);
  });

  // Proses yang lebih baru mungkin sudah mengambil alih; menghapus klaimnya
  // akan meninggalkan folder tanpa penjaga.
  test("TIDAK melepas lock milik orang lain", () => {
    writeFileSync(lockPath, "222");
    releaseWrapperLock(lockPath, 111);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe("222");
  });
});
