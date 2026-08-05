import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSlashPayload, MAX_SLASH_BATCH } from "../../../src/engine/slash/send-tool";

describe("buildSlashPayload -- satu perintah", () => {
  test("perintah tunggal jadi payload objek", () => {
    const r = buildSlashPayload({ command: "/rename sesi-x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toEqual({ command: "/rename sesi-x" });
    expect(r.ack).toContain("/rename sesi-x");
  });

  test("perintah tanpa garis miring ditolak", () => {
    const r = buildSlashPayload({ command: "rename x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("/");
  });

  test("perintah kosong ditolak", () => {
    expect(buildSlashPayload({ command: "   " }).ok).toBe(false);
  });
});

describe("buildSlashPayload -- batch", () => {
  test("batch jadi payload array, urutannya dipertahankan", () => {
    const r = buildSlashPayload({
      commands: ["/rename done-x", "/clear", "/rename idle"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toEqual([
      { command: "/rename done-x" },
      { command: "/clear" },
      { command: "/rename idle" },
    ]);
  });

  // Batch ditulis sebagai SATU berkas justru supaya tidak ada payload lain
  // menyelip di tengah urutan reset-sesi. Ack-nya harus mengatakan itu, karena
  // itulah satu-satunya alasan bentuk batch ada.
  test("ack batch menyebut sifat atomiknya", () => {
    const r = buildSlashPayload({ commands: ["/clear", "/rename idle"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack.toLowerCase()).toContain("atomic");
  });

  test("batch kosong ditolak", () => {
    expect(buildSlashPayload({ commands: [] }).ok).toBe(false);
  });

  test("batch lebih dari MAX_SLASH_BATCH ditolak, dan menyebut angkanya", () => {
    const r = buildSlashPayload({
      commands: Array.from({ length: MAX_SLASH_BATCH + 1 }, () => "/clear"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain(String(MAX_SLASH_BATCH));
  });

  // Batas persis: MAX_SLASH_BATCH item HARUS lulus. Tanpa test ini, pagar
  // yang salah pasang `>=` alih-alih `>` (terlalu ketat satu item) tidak
  // pernah ketahuan -- yang di atas cuma menguji MAX_SLASH_BATCH + 1.
  test("batch tepat MAX_SLASH_BATCH item lulus", () => {
    const r = buildSlashPayload({
      commands: Array.from({ length: MAX_SLASH_BATCH }, () => "/clear"),
    });
    expect(r.ok).toBe(true);
  });

  test("satu item batch yang cacat menolak SELURUH batch", () => {
    const r = buildSlashPayload({ commands: ["/clear", "bukan-slash"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("bukan-slash");
  });
});

describe("buildSlashPayload -- tepat satu bentuk input", () => {
  test("keduanya kosong ditolak", () => {
    expect(buildSlashPayload({}).ok).toBe(false);
  });

  test("keduanya diisi ditolak -- bukan salah satu dipilih diam-diam", () => {
    const r = buildSlashPayload({ command: "/clear", commands: ["/clear"] });
    expect(r.ok).toBe(false);
  });
});

// Keempatnya perintah lapisan Telegram dan ditolak -- tapi masing-masing
// dengan alasannya SENDIRI (2026-08-05, keputusan user via Telegram: cuma
// /new, /rename, /context yang benar-benar terpakai sekarang). Satu loop yang
// cuma meng-assert "Claude Code" ada di pesan adalah prefiks bersama yang
// lolos meski keempat kalimat spesifiknya tertukar, kosong, atau salah --
// jadi tiap perintah dapat test sendiri yang mengecek isi khasnya.
describe("perintah lapisan Telegram ditolak, bukan diteruskan", () => {
  test("/new ditolak, menyebut /clear DAN /rename sebagai penggantinya", () => {
    const r = buildSlashPayload({ command: "/new sesi-x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("/clear");
    expect(r.message).toContain("/rename");
  });

  test("/switch ditolak, menyebut /resume sebagai yang terdekat", () => {
    const r = buildSlashPayload({ command: "/switch sesi-y" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("/resume");
  });

  // Negatif dengan sengaja: ini yang mencegah kalimat lama ("There is no
  // Claude Code equivalent") kembali. /effort ADA di Claude Code --
  // COMMAND_SPECS["/effort"] di cc-wrapper/src/registry.ts ada persis untuk
  // menjawab picker konfirmasinya -- jadi mengatakan sebaliknya salah faktual.
  test("/effort ditolak, TAPI tidak bilang Claude Code tidak punya perintah itu", () => {
    const r = buildSlashPayload({ command: "/effort high" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toContain("no Claude Code equivalent");
    expect(r.message).not.toContain("There is no");
  });

  test("/delete ditolak, menyebut ini urusan lapisan Telegram", () => {
    const r = buildSlashPayload({ command: "/delete" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("Telegram");
  });

  test("penolakan berlaku juga di dalam batch", () => {
    expect(buildSlashPayload({ commands: ["/clear", "/switch x"] }).ok).toBe(false);
  });

  // Yang ditolak adalah NAMA perintahnya, bukan teks yang kebetulan memuatnya.
  test("/renew bukan /new -- pencocokan pada nama, bukan awalan", () => {
    expect(buildSlashPayload({ command: "/renew" }).ok).toBe(true);
  });

  // nameOf() harus sama ketatnya dengan classify.ts / registry.ts / pagar
  // lama yang digantikannya: potong pada whitespace APA PUN, dan huruf besar
  // dinormalkan. Tanpa ini, "/NEW sesi-x" dan "/new<TAB>sesi-x" lolos pagar.
  test("/NEW (huruf besar) tetap ditolak", () => {
    expect(buildSlashPayload({ command: "/NEW sesi-x" }).ok).toBe(false);
  });

  test("/new<TAB>sesi-x (dipisah tab, bukan spasi) tetap ditolak", () => {
    expect(buildSlashPayload({ command: "/new\tsesi-x" }).ok).toBe(false);
  });
});

// Angkanya milik cc-wrapper (MAX_BATCH_ITEMS di cc-wrapper/src/inbox.ts).
// Paket terpisah, jadi tidak bisa di-import -- dikunci di sini dengan
// MEMBACA berkas sumbernya, bukan cuma memakukan angka literal: kalau tes
// hanya menulis `expect(MAX_SLASH_BATCH).toBe(8)`, menurunkan
// MAX_BATCH_ITEMS di cc-wrapper ke angka lain tetap membuat tes ini hijau,
// padahal itu persis kegagalan yang mau dicegah.
test("batas batch sama dengan MAX_BATCH_ITEMS milik cc-wrapper", () => {
  const src = readFileSync(
    join(import.meta.dir, "../../../../cc-wrapper/src/inbox.ts"),
    "utf8"
  );
  const match = /MAX_BATCH_ITEMS = (\d+)/.exec(src);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBe(MAX_SLASH_BATCH);
});
