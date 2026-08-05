/**
 * Menulis payload ke folder yang dibaca cc-wrapper. Satu-satunya berkas di
 * lapisan ini yang menyentuh disk.
 *
 * Letak foldernya TIDAK diputuskan di sini: `slashDirIn` di `paths.ts` adalah
 * satu-satunya tempat bentuk folder bot ditulis.
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { WrapperPayload } from "./map";

/**
 * Tulis satu payload. Atomik: `.tmp` dulu, lalu rename -- wrapper membaca
 * folder ini dengan polling, dan berkas yang tertangkap setengah tertulis akan
 * ditolak sebagai JSON rusak. Mengembalikan path akhirnya.
 */
export function writePending(dir: string, payload: WrapperPayload, id: string): string {
  mkdirSync(dir, { recursive: true });
  const final = join(dir, `${id}.json`);
  const tmp = `${final}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, final);
  return final;
}
