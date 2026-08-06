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
  contextRemaining: null,
  renamedInThisSession: false,
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

  // ⚠️ DIUBAH 2026-08-06 oleh uji hidup, bukan dihapus diam-diam.
  //
  // Versi lamanya berbunyi "mati begitu sesi PUNYA NAMA" dan meng-assert
  // `sessionName: "task-audit"` cukup untuk mematikannya. Itu terbukti SALAH:
  // sesudah `/clear`, sesi baru lahir MEMBAWA nama sesi sebelumnya, jadi
  // "punya nama" selalu benar dan pengingatnya tidak pernah menyala lagi.
  //
  // Yang mematikannya sekarang bukan keberadaan nama, melainkan nama yang
  // BERGERAK sejak sesi ini lahir.
  test("mati begitu ada yang me-rename di sesi ini -- tanpa ada yang mematikannya", () => {
    expect(
      collectReminders(ctx({ sessionName: "task-audit", renamedInThisSession: true })).map(
        (r) => r.id
      )
    ).not.toContain("name-session");
  });

  test("punya nama saja TIDAK cukup mematikannya -- itu bisa nama warisan", () => {
    expect(collectReminders(ctx({ sessionName: "task-audit" })).map((r) => r.id)).toContain(
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

// Penghuni KEDUA kanal, dan sekaligus ujian apakah kanalnya benar-benar mudah
// ditambah. Ambangnya DIUKUR, bukan diwarisi: 30 sesi nyata menunjukkan biaya
// penyerahan (dari mulai menulis berkas handoff sampai sesi berakhir) bermedian
// 17k token, maksimum 29k pada kelompok yang benar-benar berhenti sesudahnya.
//
// 100k dipilih = ~6x biaya itu, karena pengingat ini bukan alarm kebakaran
// melainkan peringatan dini: saat ia menyala, bot masih harus MENYELESAIKAN
// pekerjaan yang sedang berjalan sebelum menyerahkannya.
//
// Ambang ABSOLUT, bukan persentase. Yang dijaga adalah "masih cukup untuk
// menyelesaikan dan menyerahkan", dan angka itu tidak berubah saat ukuran
// window berubah. Aturan lama (35% untuk 1M, 75% untuk 200k) menjawab
// pertanyaan yang sama dengan dua sisa yang berjarak 13x -- 650k vs 50k.
describe("pengingat handoff saat context menipis", () => {
  const c = (over: Partial<ReminderContext> = {}): ReminderContext => ({
    sessionName: "task-x",
    turnCount: 5,
    statusFresh: true,
    contextRemaining: null,
    renamedInThisSession: false,
    ...over,
  });

  test("menyala saat sisa di bawah ambang", () => {
    expect(collectReminders(c({ contextRemaining: 80_000 })).map((r) => r.id)).toContain(
      "context-low"
    );
  });

  test("diam saat ruangnya masih lega", () => {
    expect(collectReminders(c({ contextRemaining: 400_000 })).map((r) => r.id)).not.toContain(
      "context-low"
    );
  });

  // Tidak tahu sisanya BUKAN alasan untuk menyala. Pengingat yang berbunyi
  // karena datanya tidak ada akan berbunyi di setiap bot yang statuslinenya
  // belum sempat digambar -- yaitu tepat di awal tiap sesi.
  test("diam saat sisanya tidak diketahui", () => {
    expect(collectReminders(c({ contextRemaining: null })).map((r) => r.id)).not.toContain(
      "context-low"
    );
  });

  test("tidak bergantung pada nama sesi maupun jumlah giliran", () => {
    const ids = collectReminders(
      c({ contextRemaining: 50_000, sessionName: null, turnCount: 0 })
    ).map((r) => r.id);

    expect(ids).toContain("context-low");
  });

  test("kalimatnya perintah, dan menyebut apa yang harus dilakukan", () => {
    const r = REMINDERS.find((x) => x.id === "context-low")!;
    expect(r.text).toContain("handoff");
  });

  // Bukti bahwa keputusan user "kirim semua" benar-benar berlaku: dua kondisi
  // terpenuhi sekaligus, dan dua-duanya ikut. Mesin tidak memilih.
  test("dua pengingat bisa menyala bersamaan, dan keduanya ikut", () => {
    const ids = collectReminders(
      c({ contextRemaining: 50_000, sessionName: null, turnCount: 3 })
    ).map((r) => r.id);

    expect(ids).toContain("name-session");
    expect(ids).toContain("context-low");
  });
});

describe("buildReminderContext: sisa context", () => {
  test("dihitung dari ukuran window dikurangi yang sudah terpakai", () => {
    const captured = {
      captured_at_ms: 1,
      payload: {
        session_id: "abc",
        context_window: { context_window_size: 1_000_000, total_input_tokens: 940_000 },
      },
    };

    expect(buildReminderContext(captured, "abc", 1).contextRemaining).toBe(60_000);
  });

  test("payload tanpa angka context menjawab null, bukan nol", () => {
    const captured = { captured_at_ms: 1, payload: { session_id: "abc" } };

    expect(buildReminderContext(captured, "abc", 1).contextRemaining).toBeNull();
  });

  // Data basi tidak boleh dipakai untuk apa pun, termasuk angka context -- ia
  // milik sesi yang lain.
  test("data basi tidak menyumbang angka context", () => {
    const captured = {
      captured_at_ms: 1,
      payload: {
        session_id: "lama",
        context_window: { context_window_size: 1_000_000, total_input_tokens: 990_000 },
      },
    };

    expect(buildReminderContext(captured, "baru", 1).contextRemaining).toBeNull();
  });
});

// PERBAIKAN dari uji hidup 2026-08-06. Pertanyaannya diganti: bukan lagi "sesi
// ini punya nama?" melainkan "namanya BERUBAH sejak sesi ini lahir?".
//
// Sebabnya terukur: sesudah `/clear`, sesi baru LAHIR membawa nama sesi
// sebelumnya -- transcriptnya sendiri menulis customTitle lama dengan sessionId
// baru. Kondisi lama (`sessionName === null`) karena itu TIDAK PERNAH terpenuhi
// lagi sesudah sebuah jendela pernah dinamai sekali, dan fiturnya mati tanpa
// satu pun error.
describe("pengingat penamaan sesudah perbaikan nama-warisan", () => {
  const c = (over: Partial<ReminderContext> = {}): ReminderContext => ({
    sessionName: "uji-engine-mati",
    turnCount: 2,
    statusFresh: true,
    contextRemaining: null,
    renamedInThisSession: false,
    ...over,
  });

  // Ini SKENARIO NYATA yang ditemukan uji hidup, dan alasan rilis ini ada.
  test("sesi baru yang lahir membawa nama lama TETAP ditagih namanya", () => {
    expect(collectReminders(c()).map((r) => r.id)).toContain("name-session");
  });

  test("berhenti begitu ada yang me-rename di sesi ini", () => {
    expect(collectReminders(c({ renamedInThisSession: true })).map((r) => r.id)).not.toContain(
      "name-session"
    );
  });

  test("tetap diam sebelum giliran kedua", () => {
    expect(collectReminders(c({ turnCount: 1 })).map((r) => r.id)).not.toContain("name-session");
  });

  test("tetap diam saat datanya basi", () => {
    expect(collectReminders(c({ statusFresh: false })).map((r) => r.id)).not.toContain(
      "name-session"
    );
  });
});

describe("buildReminderContext: rename di sesi ini", () => {
  const cap = (sessionId: string, name: string) => ({
    captured_at_ms: 1,
    payload: { session_id: sessionId, session_name: name },
  });

  test("nama sekarang sama dengan nama saat lahir berarti BELUM di-rename", () => {
    const ctx = buildReminderContext(cap("S1", "uji-engine-mati"), "S1", 2, "uji-engine-mati");

    expect(ctx.renamedInThisSession).toBe(false);
  });

  test("nama sekarang berbeda berarti SUDAH di-rename, siapa pun pelakunya", () => {
    const ctx = buildReminderContext(cap("S1", "belajar-koding"), "S1", 2, "uji-engine-mati");

    expect(ctx.renamedInThisSession).toBe(true);
  });

  // Sesi pertama sebuah bot: lahir tanpa nama, lalu dinamai. Nama kosong harus
  // bisa jadi pembanding yang sah, bukan diperlakukan sebagai "tidak tahu".
  test("lahir tanpa nama lalu dinamai juga terbaca sebagai sudah di-rename", () => {
    const ctx = buildReminderContext(cap("S1", "topik-baru"), "S1", 2, "");

    expect(ctx.renamedInThisSession).toBe(true);
  });

  test("belum ada catatan nama-lahir berarti belum di-rename", () => {
    const ctx = buildReminderContext(cap("S1", "apa-saja"), "S1", 2, null);

    expect(ctx.renamedInThisSession).toBe(false);
  });
});

// ⚠️ MEMBALIK keputusan user 2026-08-06 pagi, atas bukti dari uji hidup sore
// harinya. Waktu itu bot-02 mengusulkan menyebut nama tool dan user memilih
// kalimatnya apa adanya; risikonya dicatat sadar di spec, kata demi kata:
// "kalau uji hidup nanti menunjukkan AI menyala tapi tidak tahu caranya,
// penyebabnya sudah tertulis dan tidak perlu dicari."
//
// Terjadi. Transcript mirza_01_bot sesi c24c1ba5 merekam botnya MEMBACA SOURCE
// CODE REPO (grep `WrapperPayload`, `renameSync`) sebelum akhirnya menemukan
// `send_slash` lewat ToolSearch, baru bisa menamai sesinya.
//
// Yang dijaga di sini bukan kalimatnya, melainkan bahwa pengingat yang menyuruh
// sebuah tindakan ikut menyebut ALAT untuk melakukannya.
test("pengingat penamaan menyebut alat yang dipakai, bukan cuma tindakannya", () => {
  const r = REMINDERS.find((x) => x.id === "name-session")!;
  expect(r.text).toContain("send_slash");
});
