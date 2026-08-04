import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendToPeer } from "../../../src/engine/agent/send";
import { MAX_HOP } from "../../../src/engine/agent/payload";

const NOW = () => new Date("2026-08-04T22:30:00.000Z");
let counter = 0;
const UUID = () => `uuid-${++counter}`;

function fleet(): { parent: string; self: string; peerInbox: string } {
  const parent = mkdtempSync(join(tmpdir(), "send-"));
  for (const name of ["bot-02", "bot-03"]) {
    mkdirSync(join(parent, name), { recursive: true });
    // Config yang SAH, bukan "{}": sejak 2026-08-05 sebuah folder dihitung bot
    // hanya bila config-nya lolos schema -- `config.json` adalah nama berkas
    // yang terlalu umum untuk dijadikan tanda pengenal sendirian.
    writeFileSync(
      join(parent, name, "config.json"),
      JSON.stringify({ token: "123:fake", allowFrom: ["1"] })
    );
  }
  return {
    parent,
    self: join(parent, "bot-02"),
    peerInbox: join(parent, "bot-03", "inbox"),
  };
}

function inboxFiles(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe("sendToPeer", () => {
  test("menulis <uuid>.json ke inbox tetangga", () => {
    const { self, peerInbox } = fleet();

    const r = sendToPeer(self, "bot-03", { text: "halo" }, NOW, UUID);

    expect(r.ok).toBe(true);
    const files = inboxFiles(peerInbox);
    expect(files.length).toBe(1);
    expect(files[0]!.endsWith(".json")).toBe(true);

    const body = JSON.parse(readFileSync(join(peerInbox, files[0]!), "utf8"));
    expect(body.from).toBe("bot-02");
    expect(body.text).toBe("halo");
    expect(body.expects_reply).toBe(false);
    expect(body.hop_count).toBe(0);
    expect(body.ts).toBe("2026-08-04T22:30:00.000Z");
  });

  // Penerima memindai folder ini dengan polling. Berkas yang tertangkap
  // setengah tertulis akan terbaca sebagai JSON rusak, jadi tmp+rename bukan
  // kerapian -- ia yang membuat pembacaan tidak pernah separuh.
  test("tidak meninggalkan berkas .tmp", () => {
    const { self, peerInbox } = fleet();

    sendToPeer(self, "bot-03", { text: "x" }, NOW, UUID);

    expect(inboxFiles(peerInbox).some((f) => f.includes(".tmp."))).toBe(false);
  });

  // Antrean offline: bot yang belum pernah dinyalakan belum punya inbox/, dan
  // menolak menitip ke situ akan membuang justru pesan yang paling perlu
  // menunggu.
  test("membuat inbox/ tujuan bila belum ada", () => {
    const { self, peerInbox } = fleet();
    expect(existsSync(peerInbox)).toBe(false);

    const r = sendToPeer(self, "bot-03", { text: "x" }, NOW, UUID);

    expect(r.ok).toBe(true);
    expect(inboxFiles(peerInbox).length).toBe(1);
  });

  test("membawa in_reply_to dan hop_count apa adanya", () => {
    const { self, peerInbox } = fleet();

    sendToPeer(self, "bot-03", { text: "sudah", in_reply_to: "u-9", hop_count: 2 }, NOW, UUID);

    const body = JSON.parse(readFileSync(join(peerInbox, inboxFiles(peerInbox)[0]!), "utf8"));
    expect(body.in_reply_to).toBe("u-9");
    expect(body.hop_count).toBe(2);
    expect(body.expects_reply).toBe(false);
  });

  // Ditolak SEBELUM menyentuh disk: pesan yang ditolak tidak boleh meninggalkan
  // jejak apa pun di folder tetangga.
  test("balasan yang menuntut balasan ditolak tanpa menulis apa pun", () => {
    const { self, peerInbox } = fleet();

    const r = sendToPeer(self, "bot-03", { text: "x", expects_reply: true, in_reply_to: "a" }, NOW, UUID);

    expect(r.ok).toBe(false);
    expect(inboxFiles(peerInbox).length).toBe(0);
  });

  test("hop di atas batas ditolak sebelum menulis, dengan kalimat yang menyuruh berhenti", () => {
    const { self, peerInbox } = fleet();

    const r = sendToPeer(self, "bot-03", { text: "x", hop_count: MAX_HOP + 1 }, NOW, UUID);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("anti-loop");
    expect(inboxFiles(peerInbox).length).toBe(0);
  });

  test("tujuan yang tidak ada ditolak", () => {
    const { self } = fleet();

    const r = sendToPeer(self, "bot-99", { text: "x" }, NOW, UUID);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("bot-99");
  });
});
