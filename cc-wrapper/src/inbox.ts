/**
 * Membaca isi satu berkas `pending/`. Murni: menerima teks, mengembalikan
 * keputusan. Tidak menyentuh disk.
 *
 * Bentuk payload mengikuti wrapper lama supaya penulis yang sudah ada (plugin
 * telegram, agent-bus) tidak perlu diubah:
 *   akar OBJEK -> satu perintah
 *   akar ARRAY -> batch, dienqueue berdampingan
 */
import type { QueueItem } from "./queue";

export const MAX_BATCH_ITEMS = 8;

export type ParsedPayload =
  | { kind: "single"; item: QueueItem }
  | { kind: "batch"; items: QueueItem[] }
  | { kind: "invalid"; error: string };

function toItem(value: unknown, index: number | null): QueueItem | string {
  const where = index === null ? "payload" : `item ${index}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where} harus objek`;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.command !== "string" || !o.command.startsWith("/")) {
    return `${where} tidak memuat slash command`;
  }
  const item: QueueItem = { command: o.command };
  if (o.confirmAfterMs !== undefined) {
    if (typeof o.confirmAfterMs !== "number" || o.confirmAfterMs < 0) {
      return `${where}: confirmAfterMs harus angka >= 0`;
    }
    item.confirmAfterMs = o.confirmAfterMs;
  }
  return item;
}

export function parsePayload(raw: string): ParsedPayload {
  let parsed: unknown;
  try {
    // Buang BOM: berkas ber-BOM sudah pernah menggigit proyek ini dua kali
    // (W-7 di config.json, W-11 lewat PowerShell Set-Content).
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    return { kind: "invalid", error: `JSON tidak bisa dibaca: ${err}` };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { kind: "invalid", error: "batch kosong" };
    if (parsed.length > MAX_BATCH_ITEMS) {
      return {
        kind: "invalid",
        error: `batch terlalu panjang (${parsed.length} item, maksimum ${MAX_BATCH_ITEMS})`,
      };
    }
    const items: QueueItem[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const r = toItem(parsed[i], i);
      if (typeof r === "string") return { kind: "invalid", error: r };
      items.push(r);
    }
    return { kind: "batch", items };
  }

  const r = toItem(parsed, null);
  if (typeof r === "string") return { kind: "invalid", error: r };
  return { kind: "single", item: r };
}
