import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planMigration,
  applyMigration,
  redactTokenInConfig,
} from "../../scripts/migrate-per-folder";

/**
 * Sebuah tiruan `~/.claude/mirza-bots` seperti bentuknya pada 2026-08-04:
 * config armada, satu database, dan empat subfolder yang isinya dibedakan
 * lewat nama berkas.
 *
 * TIRUAN, selalu. Skrip ini tidak boleh dijalankan atas state nyata oleh siapa
 * pun kecuali user, secara sadar, dengan --apply.
 */
function fakeStateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "oldstate-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  mkdirSync(join(root, "status"), { recursive: true });
  mkdirSync(join(root, "locks"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  mkdirSync(join(root, "inbox", "mirza_01_bot"), { recursive: true });
  writeFileSync(join(root, "conversations.db"), "db-bytes");
  // SQLite berjalan dalam mode WAL: transaksi terbaru hidup di berkas -wal
  // sampai di-checkpoint, BUKAN di dalam .db. Diukur pada state produksi
  // 2026-08-05: .db saja memuat 135 baris, .db + -wal memuat 137, dan pesan
  // terakhirnya mundur 74 menit.
  writeFileSync(join(root, "conversations.db-wal"), "wal-bytes");
  writeFileSync(join(root, "conversations.db-shm"), "shm-bytes");
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      allowFrom: ["1121398977"],
      timezone: "Asia/Jakarta",
      bots: { mirza_01_bot: { home: "C:/w/mirza_01_bot", token: "123:abc" } },
    })
  );
  writeFileSync(join(root, "sessions", "mirza_01_bot.id"), "sess-1");
  writeFileSync(join(root, "status", "mirza_01_bot.json"), "{}");
  writeFileSync(join(root, "status", "chained-statusline"), "statusline-lama");
  writeFileSync(join(root, "locks", "mirza_01_bot.pid"), "4242");
  writeFileSync(join(root, "logs", "session-hook.log"), "baris log");
  writeFileSync(join(root, "inbox", "mirza_01_bot", "foto.jpg"), "jpg");
  return root;
}

function newHome(): string {
  return join(mkdtempSync(join(tmpdir(), "newhome-")), "mirza_01_bot");
}

function relative(home: string, path: string): string {
  return path.slice(home.length + 1).split("\\").join("/");
}

describe("planMigration", () => {
  test("memetakan tiap berkas lama ke tempat barunya di folder bot", () => {
    const home = newHome();
    const plan = planMigration(fakeStateRoot(), home, "mirza_01_bot");
    const targets = plan.copies.map((c) => relative(home, c.to));

    expect(targets).toContain("conversations.db");
    // WAJIB ikut: tanpa -wal, riwayat yang belum di-checkpoint hilang DIAM-DIAM
    // -- database barunya terbuka baik-baik saja, cuma isinya lebih sedikit.
    expect(targets).toContain("conversations.db-wal");
    expect(targets).toContain("session.id");
    expect(targets).toContain("status.json");
    expect(targets).toContain("bot.pid");
    expect(targets).toContain("chained-statusline");
    expect(targets).toContain("data/foto.jpg");
    expect(targets).toContain("logs/session-hook.log");
  });

  test("config baru memuat token bot ini saja -- tidak ada daftar bots", () => {
    const home = newHome();
    applyMigration(planMigration(fakeStateRoot(), home, "mirza_01_bot"));

    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg).toEqual({ token: "123:abc", allowFrom: ["1121398977"], timezone: "Asia/Jakarta" });
    expect("bots" in cfg).toBe(false);
  });

  // Verifikasi DUA ARAH, pelajaran migrasi bot-uji -> mirza_01_bot: "yang baru
  // ada" tidak membuktikan "yang lama tidak ketinggalan". Berkas tanpa tujuan
  // harus DISEBUT, bukan didiamkan.
  // Berkas sisi-SQLite bukan "berkas asing": memperingatkannya melatih pembaca
  // mengabaikan warning, dan warning yang diabaikan tidak menjaga apa pun.
  test("berkas sisi conversations.db tidak dilaporkan sebagai tanpa tujuan", () => {
    const plan = planMigration(fakeStateRoot(), newHome(), "mirza_01_bot");

    expect(plan.warnings.join("\n")).not.toContain("conversations.db-wal");
    expect(plan.warnings.join("\n")).not.toContain("conversations.db-shm");
  });

  test("melaporkan berkas lama yang tidak punya tujuan", () => {
    const root = fakeStateRoot();
    writeFileSync(join(root, "berkas-asing.txt"), "x");

    const plan = planMigration(root, newHome(), "mirza_01_bot");

    expect(plan.warnings.join("\n")).toContain("berkas-asing.txt");
  });

  // Bot lain di config yang sama butuh panggilan migrasinya sendiri. Diam soal
  // ini adalah persis bentuk kegagalan "yang lama ketinggalan".
  test("menyebut bot lain di config sebagai pekerjaan yang belum selesai", () => {
    const root = fakeStateRoot();
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({
        allowFrom: ["1"],
        bots: {
          mirza_01_bot: { home: "C:/w/mirza_01_bot", token: "a" },
          "bot-tetangga": { home: "C:/w/bot-tetangga", token: "b" },
        },
      })
    );

    const plan = planMigration(root, newHome(), "mirza_01_bot");

    expect(plan.warnings.join("\n")).toContain("bot-tetangga");
  });

  test("bot yang tidak ada di config ditolak, bukan menghasilkan config tanpa token", () => {
    expect(() => planMigration(fakeStateRoot(), newHome(), "bot-99")).toThrow();
  });

  // SQL penghapus baris bot lain DICETAK, tidak dijalankan. Menghapus baris
  // riwayat adalah satu-satunya langkah yang tidak punya jalan mundur.
  test("SQL pembersih baris bot lain hanya dicetak, tidak dijalankan", () => {
    const root = fakeStateRoot();
    const plan = planMigration(root, newHome(), "mirza_01_bot");

    expect(plan.sqlDeletes.join("\n")).toContain("DELETE FROM messages");
    expect(plan.sqlDeletes.join("\n")).toContain("mirza_01_bot");
  });
});

describe("applyMigration", () => {
  test("menyalin, tidak memindahkan -- state lama tetap utuh", () => {
    const root = fakeStateRoot();
    const home = newHome();

    applyMigration(planMigration(root, home, "mirza_01_bot"));

    expect(existsSync(join(root, "conversations.db"))).toBe(true);
    expect(existsSync(join(root, "config.json"))).toBe(true);
    expect(existsSync(join(root, "sessions", "mirza_01_bot.id"))).toBe(true);
  });

  test("isi berkas sampai apa adanya", () => {
    const root = fakeStateRoot();
    const home = newHome();

    applyMigration(planMigration(root, home, "mirza_01_bot"));

    expect(readFileSync(join(home, "conversations.db"), "utf8")).toBe("db-bytes");
    expect(readFileSync(join(home, "session.id"), "utf8")).toBe("sess-1");
    expect(readFileSync(join(home, "chained-statusline"), "utf8")).toBe("statusline-lama");
    expect(readFileSync(join(home, "data", "foto.jpg"), "utf8")).toBe("jpg");
  });

  // Dijalankan dua kali harus mendarat di keadaan yang sama. Migrasi yang hanya
  // aman sekali menghukum siapa pun yang berhenti di tengah lalu mengulang.
  test("idempotent -- dijalankan dua kali hasilnya sama", () => {
    const root = fakeStateRoot();
    const home = newHome();

    applyMigration(planMigration(root, home, "mirza_01_bot"));
    applyMigration(planMigration(root, home, "mirza_01_bot"));

    expect(readFileSync(join(home, "session.id"), "utf8")).toBe("sess-1");
    expect(readFileSync(join(home, "conversations.db"), "utf8")).toBe("db-bytes");
  });

  test("berkas sumber yang tidak ada dilewati, bukan membuat migrasi gagal", () => {
    const root = mkdtempSync(join(tmpdir(), "oldstate-kosong-"));
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ allowFrom: [], bots: { "bot-x": { home: "C:/w/bot-x", token: "t" } } })
    );
    const home = join(mkdtempSync(join(tmpdir(), "newhome-")), "bot-x");

    applyMigration(planMigration(root, home, "bot-x"));

    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect(existsSync(join(home, "session.id"))).toBe(false);
  });
});

describe("redactTokenInConfig (token tidak boleh ikut tercetak)", () => {
  // Dry-run ADA supaya aman dijalankan lebih dulu -- dan justru ia yang
  // mencetak token bot ke terminal, scrollback, dan berkas log mana pun yang
  // kebetulan menangkap keluarannya. Yang ditulis ke DISK tetap nilai aslinya;
  // yang diredaksi hanya yang DITAMPILKAN.
  test("nilai token diganti penanda", () => {
    const body = JSON.stringify({ token: "8123456:AAH-rahasia", allowFrom: ["1"] }, null, 2);

    const shown = redactTokenInConfig(body);

    expect(shown).not.toContain("8123456:AAH-rahasia");
    expect(shown).toContain("<redacted>");
  });

  test("field lain tidak ikut berubah", () => {
    const body = JSON.stringify(
      { token: "rahasia", allowFrom: ["111", "222"], timezone: "Asia/Jakarta" },
      null,
      2
    );

    const shown = redactTokenInConfig(body);

    expect(shown).toContain("111");
    expect(shown).toContain("222");
    expect(shown).toContain("Asia/Jakarta");
  });

  test("body tanpa token dibiarkan apa adanya", () => {
    const body = JSON.stringify({ allowFrom: ["1"] }, null, 2);
    expect(redactTokenInConfig(body)).toBe(body);
  });

  test("token yang memuat kutip ganda tetap tertutup seluruhnya", () => {
    // Token BotFather tidak memuat kutip, tapi berkas ini juga dipakai atas
    // config yang disunting tangan -- dan penyaring yang berhenti di karakter
    // pertama yang tak terduga akan membocorkan sisanya.
    const body = '{\n  "token": "a\\"b",\n  "allowFrom": []\n}';
    expect(redactTokenInConfig(body)).not.toContain("a\\\"b");
  });
});
