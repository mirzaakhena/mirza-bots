import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFleetDb, FLEET_TABLES } from "../src/db/fleet-schema";

describe("fleet.db schema", () => {
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
