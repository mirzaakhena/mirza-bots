import { readFileSync } from "node:fs";
import { currentSessionPath } from "./paths";

/**
 * The Claude Code session this bot's window is on RIGHT NOW.
 *
 * Read on every push rather than captured once at startup, and that difference
 * is the entire point of this module. The MCP process reads
 * CLAUDE_CODE_SESSION_ID when it is spawned, and `/clear` starts a new session
 * WITHOUT respawning it -- so from the process's side nothing happened, while
 * Claude Code has moved on.
 *
 * Measured 2026-08-02, from both sides at once:
 *
 *   03:34:34  session=05b5ed06…  source="startup"
 *   03:36:37  session=18e75c98…  source="clear"
 *
 * and Claude Code's own Status screen showed exactly those two ids, in that
 * order. The SessionStart hook sees the change because it is a fresh process
 * every time; the engine cannot, because it is not. So the hook writes, and this
 * reads.
 *
 * Absent means undefined -- never a guess, never a stale leftover. An empty
 * column says "don't know"; a wrong one says "know, and here it is", and nobody
 * ever gets suspicious of the second. That is the same failure class as the
 * `fleetd listening on …` line that kept printing after the bind had failed
 * (W-4), and it cost this project real hours once already.
 */
export function readCurrentSessionId(bot: string): string | undefined {
  try {
    const id = readFileSync(currentSessionPath(bot), "utf8").trim();
    return id.length > 0 ? id : undefined;
  } catch {
    // No file yet (hook has not run), or unreadable. Both are "don't know".
    return undefined;
  }
}
