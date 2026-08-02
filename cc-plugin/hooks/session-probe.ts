#!/usr/bin/env bun
/**
 * TEMPORARY probe. Deleted as soon as it has answered its one question:
 *
 *   Does SessionStart fire on `/clear`, or only when a session is first opened?
 *
 * The whole of item 0 in the 2.5-KELUAR spec stands on that assumption. The MCP
 * process reads CLAUDE_CODE_SESSION_ID once at startup and `/clear` does not
 * restart it, so the process cannot notice the change by itself -- this hook is
 * the only candidate that could. Measuring first is cheaper than building on a
 * guess and finding out afterwards.
 *
 * Writes only. It must not be able to break a session it is merely observing:
 * every failure path returns quietly.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function main(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    // No stdin is not a reason to fail; the env var alone still answers a lot.
  }

  // Deliberately NOT reusing paths.ts: this probe must keep working even if the
  // engine cannot start (bad config, unknown cwd), because those are exactly the
  // sessions whose behaviour is interesting.
  const root = process.env.MIRZA_BOTS_HOME ?? join(homedir(), ".claude", "mirza-bots");

  try {
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(
      join(root, "logs", "session-probe.log"),
      [
        new Date().toISOString(),
        `cwd=${process.env.CLAUDE_PROJECT_DIR ?? "-"}`,
        `env_session=${process.env.CLAUDE_CODE_SESSION_ID ?? "-"}`,
        `stdin=${raw.replace(/\s+/g, " ").slice(0, 400)}`,
      ].join(" | ") + "\n"
    );
  } catch {
    // A probe that takes the session down would be worse than no probe.
  }
}

if (import.meta.main) main();
