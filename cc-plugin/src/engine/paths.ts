import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

/**
 * Folder bot yang sedang dilayani proses ini.
 *
 * Murni: env dilewatkan pemanggil, bukan dibaca di sini. Itu yang membuat
 * seluruh modul ini bisa diuji tanpa menyentuh process.env sama sekali --
 * pengganti MIRZA_BOTS_HOME yang lama, yang harus di-`delete` di afterEach dan
 * bocor antar-berkas test kalau lupa.
 *
 * MIRZA_BOTS_HOME sendiri hilang tanpa pengganti: ia ada untuk memindahkan
 * STATE ROOT, dan tidak ada lagi state root untuk dipindahkan.
 */
export function resolveBotHome(
  env: { CLAUDE_PROJECT_DIR?: string | undefined },
  cwd: string
): string {
  const fromEnv = env.CLAUDE_PROJECT_DIR?.trim();
  return fromEnv ? fromEnv : cwd;
}

/**
 * Nama bot = nama folder. Bukan singkatan, bukan pemetaan.
 *
 * Konsekuensi langsung dari "alamat bot lain = folder tetangga": kalau nama bot
 * bukan nama foldernya, `../<nama-bot>/inbox/` butuh terjemahan, terjemahan
 * butuh daftar, dan daftar itu persis yang keputusan ini buang.
 *
 * Efek samping yang diinginkan: memindahkan bot = rename folder. Migrasi
 * `bot-uji` -> `mirza_01_bot` pada 2026-08-04 menyentuh lima tempat plus dua
 * database; itu yang membuat keputusan state terpusat dibalik.
 */
export function botNameFrom(botHome: string): string {
  const normalized = botHome.split("\\").join("/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function configPathIn(botHome: string): string {
  return join(botHome, "config.json");
}

export function conversationsDbPathIn(botHome: string): string {
  return join(botHome, "conversations.db");
}

/**
 * Ditulis hook SessionStart, dibaca engine tiap push. Dulu `sessions/<bot>.id`.
 *
 * Terpisah dari lock dengan sengaja: lock menjawab "PROSES mana yang memegang
 * token ini", berkas ini menjawab "SESI mana yang sedang ditampilkan jendela
 * proses itu" -- dan yang kedua berubah tanpa yang pertama bergeser sama sekali.
 */
export function sessionIdPathIn(botHome: string): string {
  return join(botHome, "session.id");
}

/** Ditulis bridge statusline, dibaca engine saat menjawab /context. Dulu `status/<bot>.json`. */
export function statusPathIn(botHome: string): string {
  return join(botHome, "status.json");
}

/**
 * Statusline pendahulu yang WAJIB dipanggil bridge sesudah menangkap.
 *
 * Ikut pindah ke folder bot karena ia state, dan keputusannya berbunyi "seluruh
 * state pindah ke folder masing-masing bot, tidak ada yang bersama". Ia juga
 * sudah berpasangan satu-satu dengan status.json.
 */
export function chainedStatuslinePathIn(botHome: string): string {
  return join(botHome, "chained-statusline");
}

/** Pemegang token Telegram bot ini. Dulu `locks/<bot>.pid`. */
export function botPidPathIn(botHome: string): string {
  return join(botHome, "bot.pid");
}

/**
 * Berkas & gambar yang dikirim user. Dulu bernama `inbox/`, dan itu salah nama
 * sejak awal -- tidak ada yang "masuk kotak surat" di sana. Namanya diserahkan
 * ke jalur antar-bot, yang memang kotak surat.
 */
export function dataDirIn(botHome: string): string {
  return join(botHome, "data");
}

/**
 * Titipan pesan dari bot lain. Dipakai sebagaimana namanya.
 *
 * Antrean offline ikut gratis dari bentuk ini: bot yang mati tidak memindai,
 * pesannya menunggu di folder, dan `ls inbox/` memperlihatkan berapa yang
 * menunggu tanpa query apa pun.
 */
export function inboxDirIn(botHome: string): string {
  return join(botHome, "inbox");
}

export function logsDirIn(botHome: string): string {
  return join(botHome, "logs");
}

export function ensureBotDirs(botHome: string): void {
  for (const dir of [dataDirIn(botHome), inboxDirIn(botHome), logsDirIn(botHome)]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
