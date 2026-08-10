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

/**
 * Seberapa lama sebuah payload boleh menunggu di `slash/` sebelum dianggap
 * bukan lagi maksud siapa pun.
 *
 * Wrapper yang berjalan menguras folder itu dalam 500 ms, jadi apa pun yang
 * berumur menit berarti wrapper-nya memang tidak ada saat perintahnya ditulis.
 * Sepuluh menit dipilih karena ia jauh di atas semua jeda yang wajar (boot CC,
 * gerbang trust, satu percobaan ulang `--continue`) dan jauh di bawah "sesi
 * berikutnya".
 */
export const STALE_PAYLOAD_MS = 10 * 60_000;

/**
 * Apakah payload ini sudah terlalu tua untuk dijalankan.
 *
 * ## Kenapa ini perlu ada
 *
 * `cc-plugin` menulis ke `slash/` tanpa tahu ada wrapper atau tidak -- dan
 * memang tidak bisa tahu; ia hidup di dalam sesi CC, bukan di luar. Kalau user
 * membuka `claude` langsung (cara yang README dokumentasikan sebagai sah), slash
 * dari Telegram tetap ditulis dan menumpuk. Saat `mirza-bot` akhirnya
 * dijalankan, tick pertama menemukan SEMUANYA dan mengantrekan semuanya --
 * termasuk `/clear` yang menghapus konteks sesi baru yang belum sempat dipakai.
 *
 * ## Kenapa mtime, bukan stempel di dalam payload
 *
 * Bentuk payload adalah kontrak antara dua paket yang dirilis terpisah, dan
 * kontrak yang tidak perlu diubah lebih baik tidak diubah. `mtime` menjawab
 * pertanyaan yang sama persis -- kapan berkas ini ditulis -- tanpa satu pun
 * penulis payload harus tahu pagar ini ada.
 *
 * ## Arah salahnya dipilih
 *
 * `mtime` di masa depan (jam bergeser, berkas disalin) dijawab "tidak basi".
 * Perintah yang dibuang tanpa sebab lebih membingungkan daripada perintah yang
 * berjalan sedikit telat.
 */
export function isStalePayload(mtimeMs: number, nowMs: number): boolean {
  return nowMs - mtimeMs > STALE_PAYLOAD_MS;
}

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
