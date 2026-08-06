import { describe, test, expect } from "bun:test";
import { summarizePeer, renderPeerStatuses, pidFrom } from "../../../src/engine/agent/status";

// Barang terlupa PERTAMA yang ketemu 2026-08-06: `agent_status` tidak pernah
// dipindah ke sistem baru, dan skill `handoff` memakainya di tiga tempat
// penentu. Tanpa ia, sebuah bot hanya tahu SIAPA YANG ADA (`agent_list`), bukan
// SIAPA YANG SIAP.
//
// Yang sengaja TIDAK dikembalikan: `lifecycle`. Sistem lama menurunkannya dari
// prefiks nama sesi (`idle`/`task-`/`done-`), dan area-05 §5.4 mencabut itu --
// nama sesi kembali jadi label bebas untuk manusia. Mengarang lifecycle di sini
// akan menghidupkan kembali persis yang dicabut, dan kali ini dari tempat baru.
// Mesin menyediakan FAKTA; penilaian "siap atau tidak" milik AI yang membacanya.
const captured = (over: Record<string, unknown> = {}) => ({
  captured_at_ms: 1_000_000,
  payload: {
    session_name: "task-audit",
    model: { display_name: "Opus 5 (1M context)" },
    context_window: { used_percentage: 12.7 },
    ...over,
  },
});

describe("summarizePeer", () => {
  test("membaca nama sesi, context, dan model dari tangkapan statusline", () => {
    const s = summarizePeer("bot-03", captured(), true);

    expect(s.bot).toBe("bot-03");
    expect(s.online).toBe(true);
    expect(s.sessionName).toBe("task-audit");
    expect(s.contextUsedPercent).toBe(12.7);
    expect(s.model).toBe("Opus 5 (1M context)");
    expect(s.capturedAtMs).toBe(1_000_000);
  });

  // Bot yang belum pernah menggambar statusline TIDAK sama dengan bot yang
  // mati. Menjawab "offline" untuk keduanya menghapus perbedaan yang justru
  // dibutuhkan pemanggilnya.
  test("bot hidup yang belum punya tangkapan tetap online, datanya saja yang kosong", () => {
    const s = summarizePeer("bot-04", null, true);

    expect(s.online).toBe(true);
    expect(s.sessionName).toBeNull();
    expect(s.contextUsedPercent).toBeNull();
    expect(s.capturedAtMs).toBeNull();
  });

  // Kebalikannya, dan ini yang paling mudah salah: tangkapan statusline TIDAK
  // hilang saat botnya mati -- berkasnya tetap di disk. Bot mati yang punya
  // tangkapan lama akan terbaca "punya sesi bernama X" kalau `online` diambil
  // dari keberadaan data alih-alih dari prosesnya.
  test("bot mati tetap dilaporkan offline meski tangkapannya masih ada", () => {
    const s = summarizePeer("bot-05", captured(), false);

    expect(s.online).toBe(false);
    expect(s.sessionName).toBe("task-audit");
  });

  test("payload tanpa context tidak mengarang angka", () => {
    const s = summarizePeer("bot-06", captured({ context_window: undefined }), true);

    expect(s.contextUsedPercent).toBeNull();
  });
});

describe("renderPeerStatuses", () => {
  const now = 1_000_000 + 5 * 60_000; // lima menit sesudah tangkapan

  test("menyebut umur data, bukan hanya isinya", () => {
    const out = renderPeerStatuses([summarizePeer("bot-03", captured(), true)], now);

    expect(out).toContain("bot-03");
    expect(out).toContain("13%");
    expect(out).toContain("5m");
  });

  // Umur data adalah bagian dari jawabannya, bukan hiasan: `status.json` hanya
  // diperbarui saat statusline digambar ulang, dan kebasiannya sudah terukur
  // (memuat `uji-batch-1` saat sesi sebenarnya sudah `uji-batch-2`). Pemanggil
  // yang tidak diberi tahu umurnya akan memperlakukan angka basi sebagai segar.
  test("bot tanpa data mengatakan begitu, bukan menampilkan angka kosong", () => {
    const out = renderPeerStatuses([summarizePeer("bot-04", null, true)], now);

    expect(out).toContain("bot-04");
    expect(out).toContain("belum ada data");
    expect(out).not.toContain("%");
  });

  test("bot mati ditandai offline", () => {
    const out = renderPeerStatuses([summarizePeer("bot-05", captured(), false)], now);

    expect(out).toContain("offline");
  });

  test("daftar kosong menjawab dengan kalimat, bukan string kosong", () => {
    expect(renderPeerStatuses([], now)).toContain("Tidak ada bot lain");
  });
});

// `bot.pid` ditulis proses lain dan dibaca di sini apa adanya. Berkas kosong,
// berisi spasi, atau sisa tulisan setengah jadi adalah keadaan yang benar-benar
// terjadi di mesin ini -- `bot.pid` pernah berganti angka di tengah insiden
// perebutan lock 2026-08-05.
describe("pidFrom", () => {
  test("membaca angka yang ditulis dengan akhiran baris Windows", () => {
    expect(pidFrom("57284\r\n")).toBe(57284);
  });

  test("berkas kosong atau rusak menjawab null, bukan NaN", () => {
    expect(pidFrom("")).toBeNull();
    expect(pidFrom("   ")).toBeNull();
    expect(pidFrom("bukan-angka")).toBeNull();
    expect(pidFrom(null)).toBeNull();
  });

  // PID 0 dan negatif bukan proses yang bisa ditanya; melewatkannya ke
  // process.kill akan menyasar GRUP proses, bukan satu proses.
  test("nol dan negatif ditolak", () => {
    expect(pidFrom("0")).toBeNull();
    expect(pidFrom("-1")).toBeNull();
  });
});
