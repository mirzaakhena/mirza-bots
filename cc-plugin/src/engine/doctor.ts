import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { botNameFrom, botPidPathIn } from "./paths";
import type { DoctorReport, LockStatus } from "./types";

/**
 * Siapa memegang token bot INI.
 *
 * Dulu fungsi ini memetakan seluruh `config.bots`, dan itu memang alasan berkas
 * lock dikumpulkan di satu folder: "siapa melayani apa" jadi satu kali listing
 * alih-alih menyusuri enam folder. Sesudah state per-folder, pertanyaan itu
 * tidak hilang -- ia berpindah keluar dari kode, ke `ls workspace/-/bot.pid`,
 * yang bisa dijawab siapa pun tanpa menjalankan apa pun.
 *
 * Yang tersisa di sini adalah pertanyaan yang memang milik proses ini: apakah
 * ADA yang memegang tokenku, dan apakah ia masih hidup.
 */
function readLock(botHome: string): LockStatus {
  const bot = botNameFrom(botHome);
  let pid: number | null = null;
  try {
    const parsed = parseInt(readFileSync(botPidPathIn(botHome), "utf8").trim(), 10);
    if (Number.isInteger(parsed)) pid = parsed;
  } catch {
    // No lock file: nobody has claimed this bot's token.
  }

  let alive = false;
  if (pid !== null) {
    try {
      // Signal 0 checks existence without delivering anything.
      process.kill(pid, 0);
      alive = true;
    } catch {
      // Stale number left by a session that died without releasing. Reported
      // as not alive rather than dropped -- a stale lock is a real finding.
    }
  }

  return { bot, pid, alive };
}

export function buildDoctorReport(
  botHome: string,
  conversationsDb: Database,
  version: string
): DoctorReport {
  const convTableRows = conversationsDb
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
    .all();

  return {
    bot: botNameFrom(botHome),
    lock: readLock(botHome),
    conversationsReady: convTableRows.length === 1,
    version,
  };
}
