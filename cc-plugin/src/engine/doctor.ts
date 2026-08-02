import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { FLEET_TABLES } from "./db/fleet-schema";
import { botCount } from "./config";
import type { Config } from "./config";
import { lockPath } from "./paths";
import type { DoctorReport, LockStatus } from "./types";

/**
 * Who currently holds each bot's Telegram token.
 *
 * This replaces the report's old `socketPath` field. "Is the daemon's socket
 * there?" is no longer a question anyone can ask; "which bots are actually being
 * served, and by which process?" is the thing that can now go wrong -- and it is
 * the reason the lock files were centralised under the fleet root instead of
 * left in each bot's folder.
 *
 * Every configured bot appears, held or not. Omitting the unheld ones would make
 * "nobody is serving bot-03" look identical to "everything is fine".
 */
function readLocks(config: Config): LockStatus[] {
  return Object.keys(config.bots).map((bot) => {
    let pid: number | null = null;
    try {
      const parsed = parseInt(readFileSync(lockPath(bot), "utf8").trim(), 10);
      if (Number.isInteger(parsed)) pid = parsed;
    } catch {
      // No lock file: nobody has claimed this bot's token in this fleet.
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
  });
}

export function buildDoctorReport(
  config: Config,
  fleetDb: Database,
  conversationsDb: Database,
  version: string
): DoctorReport {
  const tableRows = fleetDb
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  const tableNames = new Set(tableRows.map((r) => r.name));
  const fleetTables = FLEET_TABLES.filter((t) => tableNames.has(t));

  const convTableRows = conversationsDb
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
    .all();
  const conversationsReady = convTableRows.length === 1;

  return {
    botCount: botCount(config),
    locks: readLocks(config),
    fleetTables: [...fleetTables],
    conversationsReady,
    version,
  };
}
