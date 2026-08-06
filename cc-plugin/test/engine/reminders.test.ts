import { describe, test, expect } from "bun:test";
import {
  REMINDERS,
  collectReminders,
  renderReminders,
  buildReminderContext,
  type Reminder,
  type ReminderContext,
} from "../../src/engine/reminders";
import { SYSTEM_TURN_MARKER } from "../../src/server";

const ctx = (over: Partial<ReminderContext> = {}): ReminderContext => ({
  sessionName: null,
  turnCount: 2,
  statusFresh: true,
  ...over,
});

// Penghuni pertama kanal ini. Keputusan user 2026-08-06: N = 2, dan pemicunya
// KEADAAN -- selama sesi belum bernama, pengingatnya ada di tiap pesan. Itu yang
// menghapus kebutuhan akan flag "sudah pernah diingatkan", aturan "jangan
// nagih", dan logika berhenti: begitu sesi bernama, kondisinya tidak terpenuhi
// dan pengingatnya lenyap sendiri.
describe("pengingat penamaan sesi", () => {
  test("menyala saat sesi belum bernama dan sudah cukup giliran", () => {
    expect(collectReminders(ctx()).map((r) => r.id)).toContain("name-session");
  });

  test("mati begitu sesi punya nama -- tanpa ada yang mematikannya", () => {
    expect(collectReminders(ctx({ sessionName: "task-audit" })).map((r) => r.id)).not.toContain(
      "name-session"
    );
  });

  test("belum menyala sebelum giliran kedua", () => {
    expect(collectReminders(ctx({ turnCount: 1 })).map((r) => r.id)).not.toContain("name-session");
  });

  // Guard kebasian. `status.json` cuma diperbarui saat statusline digambar
  // ulang, jadi tepat setelah sesi baru lahir ia masih memuat nama sesi
  // SEBELUMNYA. Bertindak atas data itu berarti menilai sesi yang salah --
  // pemicu yang menyala di saat yang keliru lebih berbahaya daripada tidak ada
  // pemicu, karena ia terlihat seperti sudah bekerja.
  test("diam saat datanya basi, bukan menebak", () => {
    expect(collectReminders(ctx({ statusFresh: false })).map((r) => r.id)).not.toContain(
      "name-session"
    );
  });

  test("kalimatnya perintah, bukan pernyataan keadaan", () => {
    const r = REMINDERS.find((x) => x.id === "name-session")!;
    expect(r.text).toContain("segera beri nama");
  });
});

describe("renderReminders", () => {
  const fake = (id: string, text: string): Reminder => ({ id, applies: () => true, text });

  test("tidak ada yang menyala berarti tidak ada yang ditempel", () => {
    expect(renderReminders([])).toBe("");
  });

  test("satu pengingat dibungkus penanda sumbernya", () => {
    const out = renderReminders([fake("a", "kerjakan ini")]);

    expect(out).toContain(SYSTEM_TURN_MARKER);
    expect(out).toContain("kerjakan ini");
  });

  // Keputusan user 2026-08-06: kirim SEMUA yang terpenuhi, AI yang menyusun
  // prioritasnya. Mesin tidak mengurutkan dan tidak memilih -- prioritas adalah
  // penilaian, penilaian tergantung isi pekerjaan, dan mesin tidak tahu isi
  // pekerjaan.
  test("dua pengingat dikirim dua-duanya, di bawah satu penanda", () => {
    const out = renderReminders([fake("a", "kerjakan ini"), fake("b", "kerjakan itu")]);

    expect(out).toContain("kerjakan ini");
    expect(out).toContain("kerjakan itu");
    expect(out.split(SYSTEM_TURN_MARKER).length - 1).toBe(1);
  });

  test("urutannya persis urutan yang diberikan, tanpa disusun ulang", () => {
    const out = renderReminders([fake("a", "AAA"), fake("b", "BBB")]);

    expect(out.indexOf("AAA")).toBeLessThan(out.indexOf("BBB"));
  });
});

// Jembatan dari berkas ke keputusan. Dipisah supaya guard kebasian bisa diuji
// tanpa menyentuh disk -- dan guard itu yang paling mudah salah, karena
// kegagalannya tidak terlihat: ia menghasilkan pengingat yang MASUK AKAL untuk
// sesi yang salah.
describe("buildReminderContext", () => {
  const cap = (sessionId: string, name?: string) => ({
    captured_at_ms: 1,
    payload: { session_id: sessionId, ...(name !== undefined ? { session_name: name } : {}) },
  });

  test("tangkapan milik sesi yang sama dianggap segar", () => {
    const c = buildReminderContext(cap("abc", "task-x"), "abc", 3);

    expect(c.statusFresh).toBe(true);
    expect(c.sessionName).toBe("task-x");
    expect(c.turnCount).toBe(3);
  });

  test("tangkapan milik sesi LAIN tidak segar, dan namanya tidak ikut dipakai", () => {
    const c = buildReminderContext(cap("lama", "sesi-sebelumnya"), "baru", 3);

    expect(c.statusFresh).toBe(false);
    expect(c.sessionName).toBeNull();
  });

  test("belum ada tangkapan sama sekali juga tidak segar", () => {
    expect(buildReminderContext(null, "abc", 3).statusFresh).toBe(false);
  });

  // Sesi yang belum pernah dinamai: payload-nya memang tidak memuat
  // `session_name`, dan itu keadaan normal -- bukan kerusakan.
  test("sesi segar tanpa nama menjawab null, bukan string kosong", () => {
    const c = buildReminderContext(cap("abc"), "abc", 2);

    expect(c.statusFresh).toBe(true);
    expect(c.sessionName).toBeNull();
  });

  // Tanpa id sesi sekarang, tidak ada yang bisa dibandingkan -- dan menebak
  // "segar" di situ persis kesalahan yang guard ini ada untuk mencegah.
  test("tanpa id sesi sekarang, jawabannya tidak segar", () => {
    expect(buildReminderContext(cap("abc", "x"), undefined, 2).statusFresh).toBe(false);
  });
});
