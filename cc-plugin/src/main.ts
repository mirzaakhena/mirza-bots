import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { FleetdClient } from "./fleetd-client";
import { buildServer } from "./server";

export function resolveSocketPath(): string {
  const root = process.env.MIRZA_BOTS_HOME ?? join(homedir(), ".claude", "mirza-bots");
  return join(root, "fleetd.sock");
}

export async function main(): Promise<void> {
  const client = new FleetdClient();
  const { bot } = await client.connect(resolveSocketPath(), process.cwd());
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
