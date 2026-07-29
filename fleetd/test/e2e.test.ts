import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fleetd end-to-end", () => {
  const root = join(import.meta.dir, "..");
  let home: string;
  let env: Record<string, string | undefined>;
  let fleetdProc: Bun.Subprocess;

  // Setup lives in beforeAll, not the describe body: hooks only run when this
  // suite's tests are actually selected, so the spawned daemon is always paired
  // with the afterAll that kills it, even under `bun test -t ...` filtering.
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "mirza-bots-e2e-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        allowFrom: ["123456"],
        bots: { "bot-01": { home: "/tmp/bot-01", token: "test-token" } },
      })
    );

    env = { ...process.env, MIRZA_BOTS_HOME: home };
    fleetdProc = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  });

  afterAll(() => {
    fleetdProc.kill();
    rmSync(home, { recursive: true, force: true });
  });

  test("doctor reports 1 registered bot and all fleet tables", async () => {
    const sockPath = join(home, "fleetd.sock");
    let waited = 0;
    while (!existsSync(sockPath) && waited < 5000) {
      await Bun.sleep(100);
      waited += 100;
    }
    expect(existsSync(sockPath)).toBe(true);

    const doctorProc = Bun.spawn(["bun", "run", "bin/fleetd-doctor.ts"], {
      cwd: root,
      env,
      stdout: "pipe",
    });
    const output = await new Response(doctorProc.stdout).text();
    await doctorProc.exited;

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.report.botCount).toBe(1);
    expect(parsed.report.fleetTables.length).toBe(5);
    expect(parsed.report.conversationsReady).toBe(true);
  });
});
