import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { FleetdClient } from "./fleetd-client";
import { buildServer } from "./server";

export function resolveSocketPath(): string {
  const root = process.env.MIRZA_BOTS_HOME ?? join(homedir(), ".claude", "mirza-bots");
  return join(root, "fleetd.sock");
}

// Claude Code sets CLAUDE_PROJECT_DIR for MCP servers precisely so they can
// resolve the session's project directory without depending on the process's
// working directory (which an MCP stdio server does not control and isn't
// guaranteed to match the session's project). Prefer it; fall back to
// process.cwd() for any host that doesn't set it (e.g. manual/local testing).
export function resolveIdentityCwd(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function main(): Promise<void> {
  const client = new FleetdClient();
  const { bot } = await client.connect(resolveSocketPath(), resolveIdentityCwd());
  console.error(`cc-plugin: connected to fleetd as bot "${bot}"`);

  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`cc-plugin: fatal startup error: ${err}`);
    process.exit(1);
  });
}
