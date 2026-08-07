import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeDispatchFailure } from "../src/report";

describe("describeDispatchFailure", () => {
  test("menyebut command yang gagal, bukan cuma pesan errornya", () => {
    const line = describeDispatchFailure("/rename halo", new Error("ERR_SOCKET_CLOSED"));
    expect(line).toContain("/rename halo");
    expect(line).toContain("ERR_SOCKET_CLOSED");
  });

  // Yang dilempar tidak selalu Error: node-pty melempar apa saja, dan sebuah
  // baris log berbunyi "[object Object]" sama saja dengan tidak ada log.
  test("lemparan non-Error tetap terbaca", () => {
    expect(describeDispatchFailure("/clear", "socket mati")).toContain("socket mati");
  });

  test("ditandai sebagai cc-wrapper supaya jelas siapa yang bicara", () => {
    expect(describeDispatchFailure("/clear", new Error("x"))).toContain("cc-wrapper");
  });
});

/**
 * Pagar mekanis, bukan pengingat.
 *
 * Temuan 2026-08-07: `void runPlan(...).finally(...)` menyelamatkan ANTREAN
 * (PTY-063 terpenuhi -- `dispatching` selalu dilepas) tapi menelan errornya.
 * Injeksi yang gagal tidak meninggalkan SATU baris log pun, dan perintah slash
 * user lenyap tanpa gejala.
 *
 * `.finally` tanpa `.catch` adalah bentuk kegagalan yang paling mahal di proyek
 * ini: yang tidak meninggalkan jejak tidak bisa diukur. Pagar ini yang membuat
 * pasangan itu tidak bisa dipisahkan lagi tanpa test merah.
 */
describe("pagar: dispatch yang gagal wajib meninggalkan jejak", () => {
  test("runPlan di main.ts dipanggil dengan .catch, bukan cuma .finally", () => {
    const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
    // Boolean, bukan `toContain` atas seluruh berkas: gagalnya harus terbaca
    // sebagai "false, bukan true", bukan sebagai 200 baris source di layar.
    expect(/runPlan\(/.test(src)).toBe(true);
    expect(/\.catch\(/.test(src)).toBe(true);
  });
});
