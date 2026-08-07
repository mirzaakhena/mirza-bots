import { describe, test, expect } from "bun:test";
import { summarizePeer, renderPeerStatuses } from "../../../src/engine/agent/status";

/**
 * Empat field yang DIMINTA area-07 §7.5 tapi tidak pernah ikut pindah, dan
 * ketiadaannya baru ketahuan saat rekonsiliasi Tahap 5 pada 2026-08-07 --
 * barisnya tertulis "BELUM" selama berbulan-bulan tanpa ada yang mengeceknya.
 *
 * Kenapa keempatnya, dan bukan sekadar "biar lengkap": tiga dari mereka
 * menjawab pertanyaan yang benar-benar ditanyakan saat memilih penerima
 * handoff. `id sesi` membedakan dua sesi bernama sama. `token window`
 * membuat ambang <100k bisa dihitung -- persen saja tidak cukup, karena 5%
 * dari 1M dan 5% dari 200k adalah dua dunia berbeda, dan itu persis kekeliruan
 * yang membuat ambang warisan meleset 38x. `effort` dan `biaya` menjawab
 * "seberapa mahal sesi ini kalau diteruskan".
 */
const captured = (over: Record<string, unknown> = {}) => ({
  captured_at_ms: 1_000_000,
  payload: {
    session_id: "d93c0363-03ee-44b6-8a89-5beb41d3d099",
    session_name: "task-audit",
    model: { display_name: "Opus 5 (1M context)" },
    effort: { level: "high" },
    cost: { total_cost_usd: 0.95 },
    context_window: {
      used_percentage: 12.7,
      total_input_tokens: 50_323,
      context_window_size: 1_000_000,
    },
    ...over,
  },
});

describe("field agent_status yang menyusul (area-07 §7.5)", () => {
  test("id sesi ikut dilaporkan, bukan cuma namanya", () => {
    expect(summarizePeer("bot-03", captured(), true).sessionId).toBe(
      "d93c0363-03ee-44b6-8a89-5beb41d3d099"
    );
  });

  test("token terpakai dan ukuran window dilaporkan, bukan cuma persen", () => {
    const s = summarizePeer("bot-03", captured(), true);
    expect(s.contextUsedTokens).toBe(50_323);
    expect(s.contextWindowTokens).toBe(1_000_000);
  });

  test("effort level dan biaya ikut dilaporkan", () => {
    const s = summarizePeer("bot-03", captured(), true);
    expect(s.effortLevel).toBe("high");
    expect(s.costUsd).toBe(0.95);
  });

  // Aturan yang sama dengan field lama, dan ia bukan formalitas: mesin
  // menyediakan FAKTA. Nol yang dikarang untuk data yang tidak ada adalah
  // kebohongan yang terlihat meyakinkan -- persis kekeliruan `null = ~0%`
  // yang dibatalkan hari ini juga.
  test("payload tanpa field itu menjawab null, bukan angka karangan", () => {
    const s = summarizePeer(
      "bot-06",
      captured({ effort: undefined, cost: undefined, context_window: undefined }),
      true
    );
    expect(s.effortLevel).toBeNull();
    expect(s.costUsd).toBeNull();
    expect(s.contextUsedTokens).toBeNull();
    expect(s.contextWindowTokens).toBeNull();
  });

  test("bot tanpa tangkapan sama sekali menjawab null di semua field baru", () => {
    const s = summarizePeer("bot-04", null, true);
    expect(s.sessionId).toBeNull();
    expect(s.effortLevel).toBeNull();
    expect(s.costUsd).toBeNull();
    expect(s.contextUsedTokens).toBeNull();
    expect(s.contextWindowTokens).toBeNull();
  });
});

describe("renderPeerStatuses menampilkan field baru", () => {
  const now = 1_000_000 + 5 * 60_000;

  test("menyebut token terpakai atas ukuran window, bukan persen saja", () => {
    const out = renderPeerStatuses([summarizePeer("bot-03", captured(), true)], now);
    expect(out).toContain("50.3k");
    expect(out).toContain("1M");
  });

  test("menyebut effort dan biaya", () => {
    const out = renderPeerStatuses([summarizePeer("bot-03", captured(), true)], now);
    expect(out).toContain("high");
    expect(out).toContain("0.95");
  });

  // Yang tidak ada tidak boleh muncul sebagai baris kosong atau "null".
  test("field yang kosong tidak menyisakan potongan kosong", () => {
    const out = renderPeerStatuses(
      [summarizePeer("bot-06", captured({ effort: undefined, cost: undefined }), true)],
      now
    );
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
  });
});
