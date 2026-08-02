import type { Database } from "bun:sqlite";
import { FLEET_TABLES } from "./db/fleet-schema";
import { botCount } from "./config";
import type { Config } from "./config";
import type { DoctorReport } from "./types";

export function buildDoctorReport(
  config: Config,
  fleetDb: Database,
  conversationsDb: Database,
  socketPath: string,
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
    socketPath,
    fleetTables: [...fleetTables],
    conversationsReady,
    version,
  };
}
