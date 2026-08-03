import { test, expect, describe } from "bun:test";
import { parsePayload, MAX_BATCH_ITEMS } from "../src/inbox";

describe("parsePayload", () => {
  test("objek tunggal jadi satu item", () => {
    const r = parsePayload(JSON.stringify({ command: "/compact" }));
    expect(r.kind).toBe("single");
    if (r.kind === "single") expect(r.item.command).toBe("/compact");
  });

  test("array jadi batch", () => {
    const r = parsePayload(JSON.stringify([{ command: "/clear" }, { command: "/rename x" }]));
    expect(r.kind).toBe("batch");
    if (r.kind === "batch") {
      expect(r.items.length).toBe(2);
      expect(r.items[1]!.command).toBe("/rename x");
    }
  });

  test("JSON rusak ditolak dengan alasan", () => {
    const r = parsePayload("{bukan json");
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.error).toContain("JSON");
  });

  test("command tanpa garis miring ditolak", () => {
    const r = parsePayload(JSON.stringify({ command: "compact" }));
    expect(r.kind).toBe("invalid");
  });

  test("batch kosong ditolak", () => {
    expect(parsePayload("[]").kind).toBe("invalid");
  });

  test("batch kepanjangan ditolak", () => {
    const items = Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ({ command: "/a" }));
    const r = parsePayload(JSON.stringify(items));
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.error).toContain("terlalu panjang");
  });

  test("confirmAfterMs ikut terbawa", () => {
    const r = parsePayload(JSON.stringify({ command: "/effort high", confirmAfterMs: 500 }));
    if (r.kind === "single") expect(r.item.confirmAfterMs).toBe(500);
  });

  test("confirmAfterMs negatif ditolak", () => {
    const r = parsePayload(JSON.stringify({ command: "/a", confirmAfterMs: -1 }));
    expect(r.kind).toBe("invalid");
  });

  // BOM di depan berkas: sudah pernah menggigit proyek ini (W-7, W-11).
  test("BOM di depan tidak merusak parsing", () => {
    const r = parsePayload("﻿" + JSON.stringify({ command: "/compact" }));
    expect(r.kind).toBe("single");
  });
});
