import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../../src/engine/config";

let tmp: string;
let cfgPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mirza-bots-config-"));
  cfgPath = join(tmp, "config.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("config", () => {
  test("memuat token, allowFrom, dan timezone opsional", () => {
    writeFileSync(cfgPath, JSON.stringify({ token: "abc:def", allowFrom: ["123456"] }));
    const config = loadConfig(cfgPath);
    expect(config.token).toBe("abc:def");
    expect(config.allowFrom).toEqual(["123456"]);
    expect(config.timezone).toBeUndefined();
  });

  test("accepts an optional timezone and keeps it", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ token: "abc:def", allowFrom: ["123456"], timezone: "Asia/Jakarta" })
    );
    expect(loadConfig(cfgPath).timezone).toBe("Asia/Jakarta");
  });

  // Inti keputusan (A): config bukan lagi daftar armada. Penolakannya dikunci,
  // bukan sekadar "sekarang tidak dipakai" -- config lama yang diterima
  // diam-diam akan membuat sebuah folder melayani token yang bukan miliknya,
  // dan gejalanya baru muncul saat dua sesi berebut token yang sama (insiden
  // 2026-08-04, enam bot bisu berjam-jam).
  test("MENOLAK bentuk lama yang memuat daftar bots", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        allowFrom: ["123456"],
        bots: { "bot-01": { home: "/Users/mirza/Workspace/bot-01", token: "abc:def" } },
      })
    );
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
  });

  test("menolak config tanpa token", () => {
    writeFileSync(cfgPath, JSON.stringify({ allowFrom: ["1"] }));
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
  });

  test("rejects malformed JSON", () => {
    writeFileSync(cfgPath, "{ not json");
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
  });

  test("rejects a missing file", () => {
    expect(() => loadConfig(join(tmp, "does-not-exist.json"))).toThrow(ConfigError);
  });

  test("rejects a config with an unrecognized top-level key", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ token: "abc:def", allowFrom: ["123456"], extraJunkField: true })
    );
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
  });

  // SCAR-026, ketiga kalinya BOM menggigit proyek ini. Berkas config ditulis
  // tangan oleh user; satu karakter tak terlihat tidak boleh membuat bot bisu.
  test("BOM di depan berkas tidak mematikan pembacaan", () => {
    writeFileSync(cfgPath, "﻿" + JSON.stringify({ token: "t", allowFrom: [] }));
    expect(loadConfig(cfgPath).token).toBe("t");
  });
});
