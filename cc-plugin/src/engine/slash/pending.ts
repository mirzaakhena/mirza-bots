/**
 * Menulis payload ke folder yang dibaca cc-wrapper. Satu-satunya berkas di
 * lapisan ini yang menyentuh disk.
 *
 * Letaknya mengikuti wrapper lama supaya penulis lain (agent-bus) tidak perlu
 * diubah: <projectDir>/.claude/channels/pty-controller/pending/
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { WrapperPayload } from "./map";

export function pendingDir(projectDir: string): string {
  return join(projectDir, ".claude", "channels", "pty-controller", "pending");
}

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
