import { test, expect, describe } from "bun:test";
import { parsePayload, MAX_BATCH_ITEMS, isStalePayload, STALE_PAYLOAD_MS } from "../src/inbox";

describe("parsePayload", () => {
  test("objek tunggal jadi satu item", () => {
    const r = parsePayload(JSON.stringify({ command: "/compact" }));
    expect(r.kind).toBe("single");
    if (r.kind === "single") expect(r.item.command).toBe("/compact");
  });

  test("array jadi batch", () => {
    const r = parsePayload(JSON.stringify([{ command: "/clear" }, { command: "/rename x" }]));
    expect(r.kind).toBe("batch");
    if (r.kind === "batch") {
      expect(r.items.length).toBe(2);
      expect(r.items[1]!.command).toBe("/rename x");
    }
  });

  test("JSON rusak ditolak dengan alasan", () => {
    const r = parsePayload("{bukan json");
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.error).toContain("JSON");
  });

  test("command tanpa garis miring ditolak", () => {
    const r = parsePayload(JSON.stringify({ command: "compact" }));
    expect(r.kind).toBe("invalid");
  });

  test("batch kosong ditolak", () => {
    expect(parsePayload("[]").kind).toBe("invalid");
  });

  test("batch kepanjangan ditolak", () => {
    const items = Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ({ command: "/a" }));
    const r = parsePayload(JSON.stringify(items));
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.error).toContain("terlalu panjang");
  });

  test("confirmAfterMs ikut terbawa", () => {
    const r = parsePayload(JSON.stringify({ command: "/effort high", confirmAfterMs: 500 }));
    if (r.kind === "single") expect(r.item.confirmAfterMs).toBe(500);
  });

  test("confirmAfterMs negatif ditolak", () => {
    const r = parsePayload(JSON.stringify({ command: "/a", confirmAfterMs: -1 }));
    expect(r.kind).toBe("invalid");
  });

  // BOM di depan berkas: sudah pernah menggigit proyek ini (W-7, W-11).
  test("BOM di depan tidak merusak parsing", () => {
    const r = parsePayload("﻿" + JSON.stringify({ command: "/compact" }));
    expect(r.kind).toBe("single");
  });
});

describe("isStalePayload (perintah yang menunggu terlalu lama)", () => {
  // Kenapa pagar ini ada: cc-plugin menulis ke `slash/` tanpa tahu ada wrapper
  // atau tidak -- dan memang tidak bisa tahu. Buka `claude` langsung (cara yang
  // README sendiri dokumentasikan), kirim slash dari Telegram sepanjang sore,
  // dan semuanya menumpuk. Besok pagi `mirza-bot` dijalankan dan SEMUANYA
  // disuntik berurutan ke sesi baru -- termasuk `/clear` yang menghapus konteks
  // yang belum sempat dipakai.
  //
  // Yang dipakai mtime berkasnya, bukan stempel di dalam payload: bentuk
  // payload adalah kontrak antar-paket, dan kontrak yang tidak perlu diubah
  // lebih baik tidak diubah.
  const now = 1_000_000_000_000;

  test("payload yang baru ditulis tidak basi", () => {
    expect(isStalePayload(now, now)).toBe(false);
    expect(isStalePayload(now - 1_000, now)).toBe(false);
  });

  test("tepat di ambang belum basi", () => {
    expect(isStalePayload(now - STALE_PAYLOAD_MS, now)).toBe(false);
  });

  test("lewat ambang berarti basi", () => {
    expect(isStalePayload(now - STALE_PAYLOAD_MS - 1, now)).toBe(true);
  });

  test("payload semalam basi", () => {
    expect(isStalePayload(now - 12 * 3600_000, now)).toBe(true);
  });

  test("mtime di masa depan tidak dianggap basi", () => {
    // Jam yang bergeser atau berkas yang mtimenya disunting: arah salahnya
    // dipilih ke MENJALANKAN, bukan membuang. Perintah yang dibuang tanpa
    // sebab lebih membingungkan daripada perintah yang berjalan sedikit telat.
    expect(isStalePayload(now + 60_000, now)).toBe(false);
  });
});
