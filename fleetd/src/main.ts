import { ensureStateDirs, configPath, fleetDbPath, conversationsDbPath, socketPath } from "./paths";
import { loadConfig } from "./config";
import { openFleetDb } from "./db/fleet-schema";
import { openConversationsDb } from "./db/conversations-schema";
import { startSocketServer } from "./socket/server";
import { buildDoctorReport } from "./doctor";
import type { Request, Response } from "./socket/protocol";

const VERSION = "0.1.0";

export function main(): void {
  ensureStateDirs();
  const config = loadConfig(configPath());
  const fleetDb = openFleetDb(fleetDbPath());
  const conversationsDb = openConversationsDb(conversationsDbPath());
  const sockPath = socketPath();

  startSocketServer(sockPath, (req: Request): Response => {
    if (req.type === "doctor") {
      return {
        ok: true,
        report: buildDoctorReport(config, fleetDb, conversationsDb, sockPath, VERSION),
      };
    }
    return { ok: false, error: "unknown_type" };
  });

  console.log(`fleetd listening on ${sockPath}`);
}

if (import.meta.main) {
  main();
}
