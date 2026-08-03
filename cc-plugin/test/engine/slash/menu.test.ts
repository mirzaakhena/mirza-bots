import { test, expect, describe } from "bun:test";
import { buildCommandMenu, COMMAND_DESCRIPTIONS } from "../../../src/engine/slash/menu";
import { KNOWN_COMMANDS } from "../../../src/engine/slash/classify";

describe("buildCommandMenu", () => {
  test("satu entri untuk tiap command yang benar-benar dikenal", () => {
    expect(buildCommandMenu()).toHaveLength(KNOWN_COMMANDS.length);
  });

  // Telegram menolak entri yang memuat garis miring: payload setMyCommands
  // memakai nama telanjang, dan aplikasinya yang menambahkan "/" saat menampil.
  test("nama didaftarkan tanpa garis miring", () => {
    for (const entry of buildCommandMenu()) {
      expect(entry.command.startsWith("/")).toBe(false);
    }
  });

  test("nama patuh bentuk yang diterima Telegram", () => {
    for (const entry of buildCommandMenu()) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });

  test("tiap entri punya deskripsi yang tidak kosong", () => {
    for (const entry of buildCommandMenu()) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });

  test("mendaftarkan /rename, /new, /context -- dan hanya itu di tahap ini", () => {
    expect(buildCommandMenu().map((e) => e.command).sort()).toEqual([
      "context",
      "new",
      "rename",
    ]);
  });

  // Pagar untuk tahap berikutnya: menambah /switch ke KNOWN_COMMANDS tanpa
  // menulis deskripsinya akan memunculkan entri berdeskripsi kosong di menu HP
  // user -- gagal di sini jauh lebih murah daripada gagal di layarnya.
  test("setiap command dikenal wajib punya deskripsi", () => {
    for (const name of KNOWN_COMMANDS) {
      expect(COMMAND_DESCRIPTIONS[name]).toBeDefined();
    }
  });

  // Menu adalah papan nama, bukan dapur. Mendaftarkan sesuatu yang tidak
  // dikenal berarti menjanjikan barang yang tidak ada -- persis kenapa daftar
  // ini lahir dari KNOWN_COMMANDS dan bukan dari daftar terpisah.
  test("tidak mendaftarkan apa pun di luar daftar dikenal", () => {
    const dikenal = new Set(KNOWN_COMMANDS.map((c) => c.slice(1)));
    for (const entry of buildCommandMenu()) {
      expect(dikenal.has(entry.command)).toBe(true);
    }
  });
});
