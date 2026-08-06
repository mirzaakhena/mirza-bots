import { describe, test, expect } from "bun:test";
import { renderSessionNotice, shouldNotifyRename } from "../../src/engine/session-notice";

// Dua peristiwa, satu pertanyaan (keputusan user 2026-08-06). Usul awal bot-02
// adalah "sesi berganti"; user menggantinya dengan "diberi nama baru", dan itu
// lebih baik: `/clear` tanpa rename tidak mengubah apa pun dari sisi user --
// namanya tetap nama warisan, dan user sendiri yang baru saja menekan clear.
//
// Yang benar-benar perlu diketahui cuma dua: botnya hidup, dan sesinya sekarang
// bernama apa. Keduanya menjawab pertanyaan yang SAMA, cuma pemicunya berbeda.
describe("renderSessionNotice", () => {
  test("bot yang baru hidup menyebut sesi yang ia lanjutkan", () => {
    const out = renderSessionNotice({ kind: "start", name: "cek-env-pc" }, "mirza_01_bot");

    expect(out).toContain("mirza_01_bot");
    expect(out).toContain("cek-env-pc");
  });

  // Skenario user: terminal ditutup atau crash, lalu dijalankan lagi. Yang ia
  // butuhkan bukan "botnya hidup" melainkan "dia balik ke sesi yang mana" --
  // itu persis pertanyaan yang tersisa sesudah crash.
  test("nama sesi wajib ikut, karena itu yang ditanyakan sesudah crash", () => {
    const out = renderSessionNotice({ kind: "start", name: "ngobrol-santai" }, "bot-x");

    expect(out).toContain("ngobrol-santai");
  });

  // Saat engine baru lahir, statusline bisa belum sempat digambar. Mengarang
  // nama dari tangkapan lama akan mengulang persis bug yang dibongkar siang
  // itu: sesi baru dilaporkan dengan nama sesi sebelumnya.
  test("nama yang belum terbaca dikatakan apa adanya, bukan ditebak", () => {
    const out = renderSessionNotice({ kind: "start", name: null }, "bot-x");

    expect(out).toContain("bot-x");
    expect(out.toLowerCase()).toContain("belum terbaca");
  });

  test("nama baru diumumkan tanpa mengulang kata 'hidup'", () => {
    const out = renderSessionNotice({ kind: "renamed", name: "belajar-koding" }, "bot-x");

    expect(out).toContain("belajar-koding");
    expect(out.toLowerCase()).not.toContain("hidup");
  });
});

describe("shouldNotifyRename", () => {
  test("nama yang berubah diumumkan", () => {
    expect(shouldNotifyRename("baru", "lama")).toBe(true);
  });

  test("nama yang sama tidak diumumkan ulang", () => {
    expect(shouldNotifyRename("sama", "sama")).toBe(false);
  });

  // Tidak tahu nama sekarang BUKAN alasan mengumumkan. Kalau tangkapan
  // statusline belum ada, yang benar adalah diam sampai ia datang.
  test("nama sekarang yang tidak diketahui tidak memicu apa pun", () => {
    expect(shouldNotifyRename(null, "lama")).toBe(false);
  });

  // Belum ada catatan sama sekali = keadaan tepat sesudah bot lahir, dan
  // pengumuman start sudah menanganinya. Mengumumkan lagi di sini akan membuat
  // satu kejadian menghasilkan dua pesan.
  test("belum ada catatan berarti start yang mengumumkan, bukan ini", () => {
    expect(shouldNotifyRename("apa-saja", null)).toBe(false);
  });
});
