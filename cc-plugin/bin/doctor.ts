#!/usr/bin/env bun
/**
 * `bun run doctor` -- one look at whether THIS bot's folder is healthy.
 *
 * It used to ask the daemon over the socket. There is no daemon, so it now reads
 * the same files an engine process would: the config, the conversations
 * database, and the lock file -- all of them inside this bot's own folder. That
 * also makes it useful in the case it is most needed -- when nothing is running
 * at all, which the old version could not report on because it had nobody to
 * ask.
 *
 * Satu bot, bukan armada: sesudah state per-folder, laporan tentang tetangga
 * hanya bisa dikarang. `ls workspace/-/bot.pid` menjawabnya tanpa berpura-pura.
 */
import { existsSync } from "node:fs";
import { loadConfig } from "../src/engine/config";
import { resolveBotHome } from "../src/engine/paths";
import { openConversationsDb } from "../src/engine/db/conversations-schema";
import { runDoctor } from "../src/engine/doctor";
import pkg from "../package.json";

/**
 * Adapter tipis di atas `runDoctor`. Seluruh urutannya -- termasuk aturan
 * "periksa dulu, jangan tulis apa pun" -- hidup di sana, di mana ia bisa diuji.
 *
 * `ensureBotDirs` sengaja TIDAK ada lagi di sini. Membuat folder adalah
 * pekerjaan engine, yang melakukannya karena ia memang akan memakainya; doctor
 * hanya memeriksa, dan laporan yang meninggalkan jejak di tempat yang sedang ia
 * periksa bukan laporan.
 */
function main(): void {
  const botHome = resolveBotHome(process.env, process.cwd());
  const result = runDoctor(botHome, {
    loadConfig,
    // `null` kalau berkasnya belum ada: `openConversationsDb` akan MEMBUATNYA,
    // dan "siap" untuk database yang baru saja dibuat doctor sendiri adalah
    // jawaban yang benar secara harfiah dan menyesatkan sepenuhnya.
    openDb: (path) => (existsSync(path) ? openConversationsDb(path) : null),
    version: pkg.version,
  });

  // Selalu JSON yang sah, dan exit 1 pada kegagalan: doctor dibaca manusia yang
  // sedang buru-buru DAN oleh skrip, dan keduanya lebih buruk dengan stack trace.
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

if (import.meta.main) main();
