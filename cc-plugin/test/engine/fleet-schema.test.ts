import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFleetDb, FLEET_TABLES } from "../../src/engine/db/fleet-schema";

describe("fleet.db schema", () => {
  // Dikunci PERSIS, bukan "memuat". Empat tabel spekulatif (`sessions`,
  // `handoffs`, `injections`, `incidents`) dibuang 2026-08-04 setelah diukur:
  // nol baris DAN nol rujukan kode di seluruh src/ -- 77 baris skema untuk satu
  // tabel yang benar-benar hidup. Assert yang berbunyi "memuat" akan tetap
  // hijau kalau tabel spekulatif berikutnya ditambahkan, dan justru itu yang
  // dicegah: rumah tidak dibangun sebelum penghuninya ada.
  test("FLEET_TABLES berisi persis satu tabel, bot_inbox", () => {
    expect([...FLEET_TABLES]).toEqual(["bot_inbox"]);
  });

  test("database tidak memuat tabel di luar FLEET_TABLES", () => {
    const db = openFleetDb(":memory:");
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual([...FLEET_TABLES].sort());
    db.close();
  });

  test("creates all expected tables", () => {
    const db = openFleetDb(":memory:");
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    for (const table of FLEET_TABLES) {
      expect(names.has(table)).toBe(true);
    }
  });

  test("reopening the same on-disk database file does not throw and keeps its tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "mirza-bots-fleet-schema-"));
    const dbPath = join(dir, "fleet.db");

    const first = openFleetDb(dbPath);
    first.close();

    let second: ReturnType<typeof openFleetDb> | undefined;
    expect(() => {
      second = openFleetDb(dbPath);
    }).not.toThrow();

    const rows = second!
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    for (const table of FLEET_TABLES) {
      expect(names.has(table)).toBe(true);
    }
    second!.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
