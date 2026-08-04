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
import { loadConfig } from "../src/engine/config";
import {
  resolveBotHome,
  configPathIn,
  conversationsDbPathIn,
  ensureBotDirs,
} from "../src/engine/paths";
import { openConversationsDb } from "../src/engine/db/conversations-schema";
import { buildDoctorReport } from "../src/engine/doctor";
import pkg from "../package.json";

function main(): void {
  try {
    const botHome = resolveBotHome(process.env, process.cwd());
    ensureBotDirs(botHome);
    // Dibaca meski hasilnya tidak masuk laporan: config yang rusak atau berbentuk
    // lama adalah temuan, dan doctor yang melaporkan "sehat" di atasnya lebih
    // buruk daripada doctor yang tidak ada.
    loadConfig(configPathIn(botHome));
    const report = buildDoctorReport(
      botHome,
      openConversationsDb(conversationsDbPathIn(botHome)),
      pkg.version
    );
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
  } catch (err) {
    // Still valid JSON, still exit 1: doctor is read by humans in a hurry and by
    // scripts, and both are worse off with a stack trace.
    console.log(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2));
    process.exit(1);
  }
}

if (import.meta.main) main();
