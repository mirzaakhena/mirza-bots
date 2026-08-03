import { test, expect, describe } from "bun:test";
import { validateSessionName } from "../../../src/engine/slash/session-name";

describe("validateSessionName", () => {
  test("nama wajar diterima apa adanya", () => {
    const r = validateSessionName("task-wrapper-uji");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe("task-wrapper-uji");
  });

  test("kosong ditolak dengan pesan yang menyebut caranya", () => {
    const r = validateSessionName("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("nama");
  });

  // Nama masuk ke slash CC yang diketik ke TUI; newline akan terbaca sebagai
  // Enter dan memotong perintah di tengah.
  test("newline ditolak", () => {
    expect(validateSessionName("ada\nbaris").ok).toBe(false);
    expect(validateSessionName("ada\rbaris").ok).toBe(false);
  });

  test("terlalu panjang ditolak", () => {
    expect(validateSessionName("x".repeat(200)).ok).toBe(false);
  });

  test("spasi di ujung dirapikan, bukan ditolak", () => {
    const r = validateSessionName("  nama-ku  ");
    if (r.ok) expect(r.name).toBe("nama-ku");
  });

  test("spasi di tengah diterima", () => {
    expect(validateSessionName("dua kata").ok).toBe(true);
  });
});
