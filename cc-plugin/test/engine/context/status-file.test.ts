import { test, expect, describe } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCapturedStatus,
  readCapturedStatus,
} from "../../../src/engine/context/status-file";
import { statusPathIn } from "../../../src/engine/paths";

const NOW = 1785784649346;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "status-"));
}

describe("status-file", () => {
  test("tulis lalu baca mengembalikan payload yang sama", () => {
    const p = join(scratch(), "bot-uji.json");
    writeCapturedStatus(p, { session_id: "abc" }, NOW);
    const got = readCapturedStatus(p);
    expect(got?.payload).toEqual({ session_id: "abc" } as never);
    expect(got?.captured_at_ms).toBe(NOW);
  });

  test("berkas tidak ada -> null, bukan melempar", () => {
    expect(readCapturedStatus(join(scratch(), "hilang.json"))).toBeNull();
  });

  test("JSON rusak -> null, bukan melempar", () => {
    const p = join(scratch(), "rusak.json");
    writeFileSync(p, "{ bukan json");
    expect(readCapturedStatus(p)).toBeNull();
  });

  // Pembacanya bisa datang kapan saja; berkas setengah tertulis akan terbaca
  // sebagai JSON rusak. Penulisan wajib atomik: tulis .tmp lalu rename.
  test("tidak meninggalkan berkas .tmp sesudah selesai", () => {
    const dir = scratch();
    writeCapturedStatus(join(dir, "bot-uji.json"), { a: 1 }, NOW);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  test("membuat folder induknya kalau belum ada", () => {
    const p = join(scratch(), "belum", "ada", "bot-uji.json");
    writeCapturedStatus(p, { a: 1 }, NOW);
    expect(readCapturedStatus(p)?.payload).toEqual({ a: 1 } as never);
  });

  test("menulis dua kali menimpa, bukan menumpuk", () => {
    const p = join(scratch(), "bot-uji.json");
    writeCapturedStatus(p, { versi: 1 }, NOW);
    writeCapturedStatus(p, { versi: 2 }, NOW + 1000);
    const got = readCapturedStatus(p);
    expect(got?.payload).toEqual({ versi: 2 } as never);
    expect(got?.captured_at_ms).toBe(NOW + 1000);
  });
});

describe("paths", () => {
  // Dulu test ini mengunci status/<bot>.json di bawah state root terpusat,
  // dengan alasan "state tersebar itu yang dibenahi rewrite ini". Alasan itu
  // dibalik user 2026-08-04, dan pembalikannya punya dasar baru yang dulu belum
  // ada: memindahkan bot ternyata mahal, dan dengan state di folder, pindah bot
  // = rename folder. Namanya pun ikut disederhanakan -- nama bot sudah dijawab
  // nama folder, jadi menuliskannya lagi di nama berkas cuma pengulangan.
  test("status.json berada di dalam folder bot, tanpa nama bot di namanya", () => {
    const home = join("C:", "w", "mirza_01_bot");
    expect(statusPathIn(home)).toBe(join(home, "status.json"));
  });
});
