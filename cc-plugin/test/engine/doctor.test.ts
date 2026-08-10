import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationsDb } from "../../src/engine/db/conversations-schema";
import { buildDoctorReport, runDoctor } from "../../src/engine/doctor";
import { botPidPathIn } from "../../src/engine/paths";

function botFolder(name = "bot-01"): string {
  const home = join(mkdtempSync(join(tmpdir(), "doctor-")), name);
  mkdirSync(home, { recursive: true });
  return home;
}

describe("doctor report", () => {
  // Laporan ini dulu memetakan seluruh config.bots. Sesudah state per-folder,
  // sebuah proses hanya tahu tentang dirinya sendiri -- "siapa melayani apa"
  // untuk seluruh armada berpindah ke `ls workspace/*/bot.pid`, dan doctor
  // berhenti berpura-pura tahu soal tetangganya.
  test("melaporkan satu bot -- namanya nama folder", () => {
    const report = buildDoctorReport(botFolder("bot-77"), openConversationsDb(":memory:"), "0.1.0");

    expect(report.bot).toBe("bot-77");
    expect(report.conversationsReady).toBe(true);
    expect(report.version).toBe("0.1.0");
  });

  test("melaporkan pid pemegang token dan bahwa ia hidup", () => {
    const home = botFolder();
    writeFileSync(botPidPathIn(home), String(process.pid));

    const report = buildDoctorReport(home, openConversationsDb(":memory:"), "0.1.0");

    expect(report.lock).toEqual({ bot: "bot-01", pid: process.pid, alive: true });
  });

  // Bot yang tidak dilayani siapa pun tetap dilaporkan, bukan dihilangkan:
  // seluruh gunanya laporan ini adalah membedakan "tidak berjalan" dari "aman".
  test("tanpa berkas lock, pid dilaporkan null -- bukan dihilangkan", () => {
    const report = buildDoctorReport(botFolder(), openConversationsDb(":memory:"), "0.1.0");

    expect(report.lock).toEqual({ bot: "bot-01", pid: null, alive: false });
  });

  test("a lock naming a dead pid is reported as not alive, not as held", () => {
    const home = botFolder();
    // Angka yang tidak mungkin milik proses bun mana pun. Yang penting: angka
    // basi tidak boleh terbaca sebagai "sedang melayani".
    writeFileSync(botPidPathIn(home), "999999");

    const report = buildDoctorReport(home, openConversationsDb(":memory:"), "0.1.0");

    expect(report.lock).toEqual({ bot: "bot-01", pid: 999999, alive: false });
  });
});

describe("runDoctor: memeriksa dulu, tidak menulis apa pun", () => {
  // Urutan lamanya `ensureBotDirs()` -> `loadConfig()`, jadi menjalankan doctor
  // dari folder yang BUKAN bot membuat data/ inbox/ slash/ logs/ dan sebuah
  // conversations.db kosong di sana LEBIH DULU, baru gagal. Laporan yang
  // meninggalkan jejak di folder yang sedang ia periksa bukan laporan.
  const okConfig = () => ({ token: "t", allowFrom: ["1"] });

  test("folder tanpa config yang sah dijawab error, dan database tidak pernah disentuh", () => {
    let opened = 0;
    const result = runDoctor(botFolder(), {
      loadConfig: () => {
        throw new Error("Cannot read config");
      },
      openDb: () => {
        opened++;
        return null;
      },
      version: "0.1.0",
    });

    expect(result.ok).toBe(false);
    // Yang dijaga bukan pesannya, melainkan bahwa jalur penulisan tidak pernah
    // dicapai: config diperiksa DULU.
    expect(opened).toBe(0);
  });

  test("config yang sah menghasilkan laporan lengkap", () => {
    const result = runDoctor(botFolder("bot-88"), {
      loadConfig: okConfig,
      openDb: () => openConversationsDb(":memory:"),
      version: "0.9.0",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bot).toBe("bot-88");
      expect(result.conversationsReady).toBe(true);
      expect(result.version).toBe("0.9.0");
    }
  });

  test("database yang belum ada dilaporkan belum siap, bukan dibuat", () => {
    // "Belum ada" adalah keadaan sah untuk bot yang belum pernah menerima
    // pesan. Membuatnya di sini akan membuat doctor menjawab "siap" untuk
    // sesuatu yang baru saja ia bikin sendiri.
    const result = runDoctor(botFolder(), {
      loadConfig: okConfig,
      openDb: () => null,
      version: "0.1.0",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.conversationsReady).toBe(false);
  });
});
