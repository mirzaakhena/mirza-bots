#!/usr/bin/env bun
/**
 * Dijalankan Claude Code sebagai `statusLine.command`.
 *
 * Dua tugas, dan URUTAN KEPENTINGANNYA yang paling perlu dipahami:
 *
 *   1. TERUSKAN ke statusline pendahulu -- ini yang user lihat, dan ini yang
 *      tidak boleh hilang. Ia berjalan apa pun yang terjadi di tugas kedua.
 *   2. TANGKAP payload ke berkas -- ini yang membuat /context bisa menjawab.
 *      Kalau gagal, /context yang mengalah, bukan statusline user.
 *
 * Prioritas itu tidak ditulis sebagai komentar saja; ia terbaca dari
 * strukturnya. Blok penangkap dibungkus try/catch yang sengaja menelan semua
 * kesalahan, dan blok penerus berada di luar jangkauannya.
 *
 * Berkas ini TIDAK PERNAH mencetak apa pun ke stdout. Yang tampil di baris
 * status sepenuhnya milik statusline pendahulu, byte per byte.
 *
 * ⚠️ Hanya boleh mengimpor `node:` dan modul yang juga hanya memakai `node:`.
 * Versi pertama `hooks/session-start.ts` mengimpor modul engine "supaya tidak
 * duplikat" dan TIDAK PERNAH MENYALA sambil tetap terlihat terpasang. Berkas
 * ini dijalankan puluhan kali per menit -- menyeret engine, database, atau
 * lock ke dalamnya bukan cuma lambat, ia membangunkan hal-hal yang sudah punya
 * pemilik.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { botForCwd } from "../src/engine/context/bot-for-cwd";
import { planChainInvocation } from "../src/engine/context/invoke";
import { writeCapturedStatus } from "../src/engine/context/status-file";
import { chainedStatuslinePath, configPath, statusPath } from "../src/engine/paths";

// Baca stdin. Gagal di sini pun tidak boleh menghentikan penerusan -- lihat
// urutan kepentingan di atas.
let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  input = "";
}

// --- Tugas 2: tangkap (boleh gagal diam-diam) ---
try {
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const cfgPath = configPath();
  const config = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  const bot = botForCwd(config, cwd);
  // Folder yang bukan rumah bot mana pun: tidak ditulis apa-apa. Ia tetap
  // mendapat statusline-nya lewat blok di bawah.
  if (bot !== null && input !== "") {
    writeCapturedStatus(statusPath(bot), JSON.parse(input), Date.now());
  }
} catch {
  // Sengaja kosong. Menangkap adalah tugas kedua; kegagalannya tidak boleh
  // merambat ke tugas pertama.
}

// --- Tugas 1: teruskan (selalu berjalan) ---
const chainPath = chainedStatuslinePath();
if (existsSync(chainPath)) {
  const chain = readFileSync(chainPath, "utf8").trim();
  // Rantai kosong berarti memang tidak ada pendahulu -- BUKAN berarti "belum
  // sempat diisi". Installer-lah yang menjamin bedanya: ia menolak memasang
  // kalau tidak yakin, jadi rantai kosong di sini sudah lolos pemeriksaan.
  if (chain) {
    const plan = planChainInvocation(chain);
    spawnSync(plan.command, {
      input,
      stdio: ["pipe", "inherit", "inherit"],
      shell: plan.shell,
      // Tanpa ini, perintah yang ternyata membuka aplikasi GUI akan
      // memunculkan jendela di wajah user, puluhan kali per menit.
      windowsHide: true,
      // Baris status yang menggantung MEMBEKUKAN tampilan Claude Code. Lebih
      // baik statusline kosong sesaat daripada CC yang berhenti menggambar --
      // dan ini bukan hipotetis: versi pertama menggantung dua menit penuh
      // karena Windows membuka .sh alih-alih menjalankannya.
      timeout: 5000,
    });
  }
}
