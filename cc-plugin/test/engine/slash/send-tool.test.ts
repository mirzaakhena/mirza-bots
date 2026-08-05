import { test, expect, describe } from "bun:test";
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

// D-3. Keempatnya perintah lapisan Telegram dan TIDAK ADA di Claude Code.
// Menyuntikkannya membuat CC menampilkan "unknown command" di layar dan AI
// tidak pernah tahu perintahnya menguap.
describe("perintah lapisan Telegram ditolak, bukan diteruskan", () => {
  for (const cmd of ["/new sesi-x", "/switch sesi-y", "/delete", "/effort high"]) {
    test(`${cmd} ditolak`, () => {
      const r = buildSlashPayload({ command: cmd });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.message).toContain("Claude Code");
    });
  }

  test("penolakan /new menunjukkan penggantinya, bukan cuma menolak", () => {
    const r = buildSlashPayload({ command: "/new sesi-x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("/clear");
    expect(r.message).toContain("/rename");
  });

  test("penolakan berlaku juga di dalam batch", () => {
    expect(buildSlashPayload({ commands: ["/clear", "/switch x"] }).ok).toBe(false);
  });

  // Yang ditolak adalah NAMA perintahnya, bukan teks yang kebetulan memuatnya.
  test("/renew bukan /new -- pencocokan pada nama, bukan awalan", () => {
    expect(buildSlashPayload({ command: "/renew" }).ok).toBe(true);
  });
});

// Angkanya milik cc-wrapper (MAX_BATCH_ITEMS di cc-wrapper/src/inbox.ts).
// Paket terpisah, jadi tidak bisa di-import; dikunci di sini supaya
// perbedaannya jatuh sebagai test merah, bukan sebagai batch yang ditolak
// wrapper sesudah AI diberi tahu batch-nya terkirim.
test("batas batch sama dengan MAX_BATCH_ITEMS milik cc-wrapper", () => {
  expect(MAX_SLASH_BATCH).toBe(8);
});
