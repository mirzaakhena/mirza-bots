import { test, expect, describe } from "bun:test";
import { renderContext } from "../../../src/engine/context/render";

const NOW = 1785784649346;

describe("renderContext", () => {
  test("menampilkan persen dan jumlah token context", () => {
    const out = renderContext(
      {
        captured_at_ms: NOW,
        payload: {
          context_window: {
            used_percentage: 9,
            total_input_tokens: 92323,
            context_window_size: 1000000,
          },
        },
      },
      NOW
    );
    expect(out).toContain("Context");
    expect(out).toContain("9%");
  });

  test("payload tanpa context_window tetap menghasilkan teks, bukan melempar", () => {
    const out = renderContext({ captured_at_ms: NOW, payload: {} }, NOW);
    expect(out).toContain("Context");
    expect(typeof out).toBe("string");
  });

  // Menulis "0%" untuk sesuatu yang tidak diketahui adalah berbohong dengan
  // angka. Yang tidak ada dihilangkan, bukan diberi nilai palsu.
  test("rate limit yang tidak ada DIHILANGKAN, bukan ditulis 0%", () => {
    const out = renderContext({ captured_at_ms: NOW, payload: {} }, NOW);
    expect(out).not.toContain("Rate Limit 5h");
  });

  test("rate limit ditampilkan kalau ada", () => {
    const out = renderContext(
      {
        captured_at_ms: NOW,
        payload: { rate_limits: { five_hour: { used_percentage: 2, resets_at: 1785798600 } } },
      },
      NOW
    );
    expect(out).toContain("Rate Limit 5h");
    expect(out).toContain("2%");
  });

  test("nama sesi ikut tampil kalau diberikan", () => {
    const out = renderContext(
      { captured_at_ms: NOW, payload: { session_id: "65eb550e-31f4-41b9-80f9-e9402388c875" } },
      NOW,
      { sessionName: "task-uji" }
    );
    expect(out).toContain("task-uji");
  });

  // nowMs wajib diberikan pemanggil: modul murni tidak boleh membaca jam
  // dinding, karena testnya akan ikut berubah tiap kali dijalankan.
  test("nowMs dipakai untuk menghitung sisa waktu reset, bukan jam dinding", () => {
    const resetsAt = Math.floor(NOW / 1000) + 3600;
    const a = renderContext(
      { captured_at_ms: NOW, payload: { rate_limits: { five_hour: { used_percentage: 5, resets_at: resetsAt } } } },
      NOW
    );
    const b = renderContext(
      { captured_at_ms: NOW, payload: { rate_limits: { five_hour: { used_percentage: 5, resets_at: resetsAt } } } },
      NOW + 1800_000
    );
    expect(a).not.toBe(b);
  });
});
