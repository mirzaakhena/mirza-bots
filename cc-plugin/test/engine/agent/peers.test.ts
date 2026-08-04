import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPeers, resolvePeer } from "../../../src/engine/agent/peers";

function fleet(): { parent: string; self: string } {
  const parent = mkdtempSync(join(tmpdir(), "fleet-"));
  for (const name of ["bot-01", "bot-02", "bot-03"]) {
    mkdirSync(join(parent, name), { recursive: true });
    writeFileSync(join(parent, name, "config.json"), "{}");
  }
  // Folder tetangga yang BUKAN bot: tidak punya config.json. Folder induk
  // memuat macam-macam, dan daftar bot harus tetap benar tanpa berkas daftar.
  mkdirSync(join(parent, "catatan"), { recursive: true });
  return { parent, self: join(parent, "bot-02") };
}

describe("listPeers", () => {
  test("daftar bot adalah isi folder induk, dibaca langsung", () => {
    expect(listPeers(fleet().self).sort()).toEqual(["bot-01", "bot-03"]);
  });

  test("dirinya sendiri tidak masuk daftar tetangga", () => {
    expect(listPeers(fleet().self)).not.toContain("bot-02");
  });

  test("folder tanpa config.json bukan bot", () => {
    expect(listPeers(fleet().self)).not.toContain("catatan");
  });

  test("folder induk yang tidak terbaca menghasilkan daftar kosong, bukan lemparan", () => {
    expect(listPeers(join(tmpdir(), "tidak-ada-9999", "bot-x"))).toEqual([]);
  });
});

describe("resolvePeer", () => {
  test("alamat tujuan adalah inbox/ folder tetangga", () => {
    const { parent, self } = fleet();
    const r = resolvePeer(self, "bot-03");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inbox).toBe(join(parent, "bot-03", "inbox"));
  });

  // Validasi ikut gratis dari konvensi ini: salah ketik nama ketahuan seketika,
  // bukan hilang tanpa jejak di folder yang tidak ada.
  test("nama yang salah ketik ditolak, dan tetangga yang ada disebutkan", () => {
    const r = resolvePeer(fleet().self, "bot-30");

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("bot-30");
      expect(r.error).toContain("bot-01");
    }
  });

  test("mengirim ke diri sendiri ditolak", () => {
    expect(resolvePeer(fleet().self, "bot-02").ok).toBe(false);
  });

  // Nama tujuan ditulis AI. Tanpa pagar ini "../.." adalah alamat yang sah dan
  // pesan bisa mendarat di mana saja di disk.
  test("nama dengan separator path atau titik ditolak", () => {
    const { self } = fleet();

    expect(resolvePeer(self, "../bot-03").ok).toBe(false);
    expect(resolvePeer(self, "bot-03/inbox").ok).toBe(false);
    expect(resolvePeer(self, "bot-03\\inbox").ok).toBe(false);
    expect(resolvePeer(self, "..").ok).toBe(false);
    expect(resolvePeer(self, "").ok).toBe(false);
  });
});
