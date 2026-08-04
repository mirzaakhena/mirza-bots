#!/usr/bin/env bun
/**
 * `bun run doctor` -- one look at whether this machine's fleet is healthy.
 *
 * It used to ask the daemon over the socket. There is no daemon, so it now reads
 * the same files an engine process would: the config, the conversations database, and the
 * lock directory. That also makes it useful in the case it is most needed --
 * when nothing is running at all, which the old version could not report on
 * because it had nobody to ask.
 */
import { loadConfig } from "../src/engine/config";
import { configPath, conversationsDbPath, ensureStateDirs } from "../src/engine/paths";
import { openConversationsDb } from "../src/engine/db/conversations-schema";
import { buildDoctorReport } from "../src/engine/doctor";
import pkg from "../package.json";

function main(): void {
  try {
    ensureStateDirs();
    const config = loadConfig(configPath());
    const report = buildDoctorReport(
      config,
      openConversationsDb(conversationsDbPath()),
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
