/**
 * Berkas tangkapan statusline: satu-satunya bentuk penyimpanan yang mungkin,
 * karena payload statusline di-PUSH Claude Code ke command-nya dan tidak bisa
 * ditarik kapan pun. Yang tidak dicatat saat lewat, hilang.
 *
 * Sengaja setipis mungkin -- seluruh keputusan bentuk balasan ada di render.ts
 * yang murni. Berkas ini hanya tahu cara menaruh dan mengambil.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CapturedStatus } from "./render";

export function writeCapturedStatus(path: string, payload: unknown, nowMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({ captured_at_ms: nowMs, payload });
  // Atomik. Pembacanya bisa datang di tengah penulisan, dan berkas setengah
  // jadi akan terbaca sebagai JSON rusak -- yaitu "tidak ada data", yang
  // membuat /context berbohong soal keadaan.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/**
 * `null` berarti "tidak ada data yang bisa dipercaya" -- baik karena berkasnya
 * belum ada maupun karena isinya rusak. Pemanggil memperlakukan keduanya sama:
 * katakan belum ada data, jangan menampilkan angka yang dikarang.
 */
export function readCapturedStatus(path: string): CapturedStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as CapturedStatus;
  } catch {
    return null;
  }
}
