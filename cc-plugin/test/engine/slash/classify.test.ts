import { test, expect, describe } from "bun:test";
import { classify, KNOWN_COMMANDS } from "../../../src/engine/slash/classify";

describe("classify", () => {
  test("teks biasa bukan slash", () => {
    expect(classify("halo bot").kind).toBe("not-slash");
    expect(classify("").kind).toBe("not-slash");
  });

  test("command dikenal dengan argumen", () => {
    const r = classify("/rename sesi-baru");
    expect(r.kind).toBe("known");
    if (r.kind === "known") {
      expect(r.name).toBe("/rename");
      expect(r.arg).toBe("sesi-baru");
    }
  });

  test("command dikenal tanpa argumen", () => {
    const r = classify("/new");
    expect(r.kind).toBe("known");
    if (r.kind === "known") expect(r.arg).toBe("");
  });

  // Argumen dipertahankan huruf besar-kecilnya; nama command tidak.
  test("nama command tidak peduli huruf besar-kecil, argumennya iya", () => {
    const r = classify("/RENAME Sesi-Besar");
    expect(r.kind).toBe("known");
    if (r.kind === "known") {
      expect(r.name).toBe("/rename");
      expect(r.arg).toBe("Sesi-Besar");
    }
  });

  test("command tak dikenal dilaporkan apa adanya", () => {
    const r = classify("/compact");
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") expect(r.command).toBe("/compact");
  });

  // Jebakan yang sama sudah pernah dijaga eksplisit di slash-guards lama.
  test("command berawalan sama tidak ikut cocok", () => {
    const r = classify("/renamer x");
    expect(r.kind).toBe("unknown");
  });

  test("spasi di depan dan belakang tidak mengubah hasil", () => {
    const r = classify("   /rename   sesi   ");
    expect(r.kind).toBe("known");
    if (r.kind === "known") expect(r.arg).toBe("sesi");
  });

  test("hanya garis miring bukan command", () => {
    expect(classify("/").kind).toBe("not-slash");
  });

  // Daftarnya dikunci PERSIS, bukan sekadar "memuat" -- supaya menambah
  // sesuatu ke KNOWN_COMMANDS tidak pernah bisa terjadi diam-diam. /context
  // masuk di tahap 2, /branch di tahap 3; /switch belum, ia menunggu picker
  // terpaginasi yang belum ada di repo ini.
  test("daftar dikenal persis empat di tahap ini", () => {
    expect([...KNOWN_COMMANDS].sort()).toEqual(["/branch", "/context", "/new", "/rename"]);
  });
});
