import { test, expect, describe } from "bun:test";
import {
  validateOutgoing,
  parseAgentMessage,
  MAX_HOP,
  MAX_BODY_BYTES,
} from "../../../src/engine/agent/payload";

const base = { text: "halo", expects_reply: false, hop_count: 0 };

describe("validateOutgoing", () => {
  test("pesan biasa lolos", () => {
    expect(validateOutgoing(base).ok).toBe(true);
  });

  test("pertanyaan (expects_reply) lolos bila BUKAN balasan", () => {
    expect(validateOutgoing({ ...base, expects_reply: true }).ok).toBe(true);
  });

  // Ini pagar strukturalnya, dan satu-satunya alasan hop guard boleh jadi
  // jaring pengaman alih-alih rem harian: balasan yang menuntut balasan membuat
  // A<->B sopan selamanya. Satu baris membuatnya MUSTAHIL, bukan dibatasi.
  test("balasan TIDAK BOLEH menuntut balasan", () => {
    const r = validateOutgoing({ ...base, expects_reply: true, in_reply_to: "abc" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("balasan");
  });

  test("balasan tanpa expects_reply lolos", () => {
    expect(validateOutgoing({ ...base, in_reply_to: "abc" }).ok).toBe(true);
  });

  // Ditolak DI SISI PENGIRIM supaya AI mendapat kalimat yang menyuruhnya
  // berhenti me-relay, bukan pesan yang hilang diam-diam di seberang.
  test("hop_count di atas MAX_HOP ditolak", () => {
    const r = validateOutgoing({ ...base, hop_count: MAX_HOP + 1 });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("anti-loop");
  });

  test("hop_count tepat MAX_HOP masih lolos", () => {
    expect(validateOutgoing({ ...base, hop_count: MAX_HOP }).ok).toBe(true);
  });

  test("hop_count negatif atau pecahan ditolak", () => {
    expect(validateOutgoing({ ...base, hop_count: -1 }).ok).toBe(false);
    expect(validateOutgoing({ ...base, hop_count: 1.5 }).ok).toBe(false);
  });

  test("teks kosong ditolak", () => {
    expect(validateOutgoing({ ...base, text: "" }).ok).toBe(false);
  });

  test("teks di atas batas byte ditolak", () => {
    expect(validateOutgoing({ ...base, text: "x".repeat(MAX_BODY_BYTES + 1) }).ok).toBe(false);
  });
});

describe("parseAgentMessage", () => {
  const good = {
    id: "u-1",
    ts: "2026-08-04T22:00:00Z",
    from: "bot-03",
    text: "kerjakan X",
    expects_reply: true,
    hop_count: 1,
  };

  test("membaca payload yang sah", () => {
    const r = parseAgentMessage(JSON.stringify(good));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.msg.from).toBe("bot-03");
      expect(r.msg.expects_reply).toBe(true);
      expect(r.msg.hop_count).toBe(1);
      expect(r.msg.in_reply_to).toBeUndefined();
    }
  });

  test("hop_count yang tidak ditulis dibaca sebagai 0", () => {
    const { hop_count, ...tanpaHop } = good;
    const r = parseAgentMessage(JSON.stringify(tanpaHop));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msg.hop_count).toBe(0);
  });

  // BOM sudah menggigit proyek ini tiga kali (SCAR-026). Payload ini ditulis
  // proses lain, kadang oleh tangan manusia saat menguji.
  test("BOM di depan tidak mematikan pembacaan", () => {
    expect(parseAgentMessage("﻿" + JSON.stringify(good)).ok).toBe(true);
  });

  test("payload rusak ditolak dengan alasan, bukan dilempar", () => {
    const r = parseAgentMessage("{bukan json");

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  test("field wajib yang hilang ditolak", () => {
    const { from, ...tanpaFrom } = good;
    expect(parseAgentMessage(JSON.stringify(tanpaFrom)).ok).toBe(false);
  });

  test("expects_reply yang bukan boolean ditolak", () => {
    expect(parseAgentMessage(JSON.stringify({ ...good, expects_reply: "true" })).ok).toBe(false);
  });

  // Divalidasi di KEDUA sisi: pengirimnya bisa saja versi lama, atau berkasnya
  // ditulis tangan. Aturan yang hanya dijaga satu sisi bukan aturan.
  test("payload yang melanggar aturan balasan ditolak juga di sisi penerima", () => {
    expect(parseAgentMessage(JSON.stringify({ ...good, in_reply_to: "z" })).ok).toBe(false);
  });

  test("hop_count di atas MAX_HOP ditolak juga di sisi penerima", () => {
    expect(parseAgentMessage(JSON.stringify({ ...good, hop_count: MAX_HOP + 1 })).ok).toBe(false);
  });

  test("array di akar ditolak -- payload adalah satu pesan, bukan batch", () => {
    expect(parseAgentMessage(JSON.stringify([good])).ok).toBe(false);
  });
});
