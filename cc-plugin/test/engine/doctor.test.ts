import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationsDb } from "../../src/engine/db/conversations-schema";
import { buildDoctorReport } from "../../src/engine/doctor";
import type { Config } from "../../src/engine/config";

const config: Config = {
  allowFrom: ["1"],
  bots: {
    "bot-01": { home: "/tmp/bot-01", token: "a" },
    "bot-02": { home: "/tmp/bot-02", token: "b" },
  },
};

describe("doctor report", () => {
  test("reports bot count, fleet tables, and conversations readiness", () => {
    const report = buildDoctorReport(
      config,
      openConversationsDb(":memory:"),
      "0.1.0"
    );

    expect(report.botCount).toBe(2);
    expect(report.conversationsReady).toBe(true);
    expect(report.version).toBe("0.1.0");
  });

  // Replaces the old socketPath field. "Is the daemon's socket there?" stopped
  // being a question anyone can ask; "who currently holds each bot's token?" is
  // the thing that can now go wrong, and it is the reason locks/ is centralised.
  test("reports which bot tokens are held, and by which pid", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-"));
    mkdirSync(join(root, "locks"), { recursive: true });
    writeFileSync(join(root, "locks", "bot-01.pid"), String(process.pid));
    process.env.MIRZA_BOTS_HOME = root;

    try {
      const report = buildDoctorReport(
        config,
        openConversationsDb(":memory:"),
        "0.1.0"
      );

      const held = report.locks.find((l) => l.bot === "bot-01");
      expect(held).toEqual({ bot: "bot-01", pid: process.pid, alive: true });

      // A bot nobody is serving is reported as such rather than omitted: the
      // whole point of the report is telling "not running" apart from "fine".
      expect(report.locks.find((l) => l.bot === "bot-02")).toEqual({
        bot: "bot-02",
        pid: null,
        alive: false,
      });
    } finally {
      delete process.env.MIRZA_BOTS_HOME;
    }
  });

  test("a lock naming a dead pid is reported as not alive, not as held", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-"));
    mkdirSync(join(root, "locks"), { recursive: true });
    // 2 is init/System -- never a bun process, and on Windows never signalable
    // by us. What matters is that a stale number does not read as "serving".
    writeFileSync(join(root, "locks", "bot-01.pid"), "999999");
    process.env.MIRZA_BOTS_HOME = root;

    try {
      const report = buildDoctorReport(
        config,
        openConversationsDb(":memory:"),
        "0.1.0"
      );

      expect(report.locks.find((l) => l.bot === "bot-01")).toEqual({
        bot: "bot-01",
        pid: 999999,
        alive: false,
      });
    } finally {
      delete process.env.MIRZA_BOTS_HOME;
    }
  });
});
