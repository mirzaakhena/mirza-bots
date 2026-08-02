import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startEngine } from "./engine/engine";
import { buildServer } from "./server";

// Claude Code sets CLAUDE_PROJECT_DIR for MCP servers precisely so they can
// resolve the session's project directory without depending on the process's
// working directory (which an MCP stdio server does not control and isn't
// guaranteed to match the session's project). Prefer it; fall back to
// process.cwd() for any host that doesn't set it (e.g. manual/local testing).
export function resolveIdentityCwd(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

// Claude Code exports this into every MCP server it launches. It is a snapshot
// taken when the MCP connection was made, not a live session tracker: if the
// user runs /clear or switches sessions, the plugin process is not guaranteed to
// restart with a new id (spec §8 risk 2). Good enough to attribute stored
// messages to a session; authoritative session routing belongs to Tahap 4.
export function resolveSessionId(): string | undefined {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  return id && id.length > 0 ? id : undefined;
}

export async function main(): Promise<void> {
  const started = startEngine(resolveIdentityCwd(), resolveSessionId());

  if (!started.ok) {
    // Deliberately NOT an exit. A plugin that dies here is indistinguishable
    // from a plugin that was never installed -- which is exactly what cost two
    // hours on 2026-08-01 (W-16) and left nothing behind to diagnose, because a
    // process that dies before it can speak leaves no evidence. Serve the tools
    // anyway, so the reason reaches whoever calls one.
    console.error(`cc-plugin: ${started.message}`);
    const server = buildServer({ kind: "unavailable", reason: started.message });
    await server.connect(new StdioServerTransport());
    return;
  }

  console.error(`cc-plugin: engine running for bot "${started.engine.bot}"`);
  const server = buildServer(started.engine);
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`cc-plugin: fatal startup error: ${err}`);
    process.exit(1);
  });
}
