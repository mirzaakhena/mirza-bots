import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { botNameFrom, botPidPathIn, configPathIn, conversationsDbPathIn } from "./paths";
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

/**
 * `null` berarti berkas databasenya BELUM ADA, dan itu keadaan sah untuk bot
 * yang belum pernah menerima pesan. Ia dilaporkan `conversationsReady: false` --
 * bukan dibuat di tempat, karena doctor yang menjawab "siap" untuk sesuatu yang
 * baru saja ia bikin sendiri tidak melaporkan apa pun.
 */
export function buildDoctorReport(
  botHome: string,
  conversationsDb: Database | null,
  version: string
): DoctorReport {
  const convTableRows =
    conversationsDb === null
      ? []
      : conversationsDb
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
          .all();

  return {
    bot: botNameFrom(botHome),
    lock: readLock(botHome),
    conversationsReady: convTableRows.length === 1,
    version,
  };
}

export type DoctorDeps = {
  /** Melempar bila config tidak ada / rusak / bentuk lama. */
  loadConfig: (path: string) => unknown;
  /** `null` bila berkas databasenya belum ada. TIDAK boleh membuatnya. */
  openDb: (path: string) => Database | null;
  version: string;
};

export type DoctorResult = ({ ok: true } & DoctorReport) | { ok: false; error: string };

/**
 * Seluruh alur `bun run doctor`, dengan efek sampingnya disuntik.
 *
 * ## Kenapa urutannya yang dijaga, bukan sekadar hasilnya
 *
 * Urutan lamanya `ensureBotDirs()` lalu `loadConfig()`. Menjalankan doctor dari
 * folder yang BUKAN bot karena itu membuat `data/ inbox/ slash/ logs/` dan
 * sebuah `conversations.db` kosong di sana LEBIH DULU, baru gagal -- dan README
 * sendiri menyuruh `cd cc-plugin && bun run doctor`, yaitu persis folder yang
 * tidak boleh dikotori.
 *
 * Sekarang tidak ada folder yang dibuat sama sekali. Doctor MEMERIKSA; membuat
 * folder adalah pekerjaan engine, dan engine yang melakukannya karena ia memang
 * akan memakainya. Laporan yang meninggalkan jejak di tempat yang sedang ia
 * periksa bukan laporan.
 */
export function runDoctor(botHome: string, deps: DoctorDeps): DoctorResult {
  try {
    // Config DULU. Ia satu-satunya yang bisa menjawab "folder ini bot atau
    // bukan", dan tidak ada satu byte pun boleh ditulis sebelum ia menjawab.
    deps.loadConfig(configPathIn(botHome));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  return {
    ok: true,
    ...buildDoctorReport(botHome, deps.openDb(conversationsDbPathIn(botHome)), deps.version),
  };
}
