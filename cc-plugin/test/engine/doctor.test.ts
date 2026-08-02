import { describe, test, expect } from "bun:test";
import { openFleetDb, FLEET_TABLES } from "../../src/engine/db/fleet-schema";
import { openConversationsDb } from "../../src/engine/db/conversations-schema";
import { buildDoctorReport } from "../../src/engine/doctor";
import type { Config } from "../../src/engine/config";

describe("doctor report", () => {
  test("reports bot count, fleet tables, and conversations readiness", () => {
    const config: Config = {
      allowFrom: ["1"],
      bots: {
        "bot-01": { home: "/tmp/bot-01", token: "a" },
        "bot-02": { home: "/tmp/bot-02", token: "b" },
      },
    };
    const fleetDb = openFleetDb(":memory:");
    const conversationsDb = openConversationsDb(":memory:");

    const report = buildDoctorReport(config, fleetDb, conversationsDb, "/tmp/fleetd.sock", "0.1.0");

    expect(report.botCount).toBe(2);
    expect(report.fleetTables.length).toBe(FLEET_TABLES.length);
    expect(report.conversationsReady).toBe(true);
    expect(report.socketPath).toBe("/tmp/fleetd.sock");
    expect(report.version).toBe("0.1.0");
  });
});
