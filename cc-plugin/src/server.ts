import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FleetdClient } from "./fleetd-client";

export function buildServer(client: FleetdClient): McpServer {
  const server = new McpServer({ name: "cc-plugin", version: "0.1.0" });

  server.registerTool(
    "reply",
    {
      description:
        "Send a reply message to the user on Telegram. Optionally attach inline keyboard buttons as rows of {text, data} -- pressing a button delivers `data` back as the user's next message.",
      inputSchema: {
        text: z.string().min(1),
        buttons: z
          .array(z.array(z.object({ text: z.string().min(1), data: z.string().min(1) })))
          .optional(),
      },
    },
    async ({ text, buttons }) => {
      await client.reply(text, buttons);
      return { content: [{ type: "text", text: "sent" }] };
    }
  );

  client.onPush((msg) => {
    // SCAR-056: Claude Code's notification meta schema is Record<string,string>
    // strictly -- fleetd's PushMessage.meta is already typed that way, but this
    // forwarder is the last point of defense: never pass a value through unless
    // it's already a string. Anything else silently drops the WHOLE notification
    // on the Claude Code side with no error surfaced anywhere.
    const safeMeta: Record<string, string> = {};
    for (const [key, value] of Object.entries(msg.meta)) {
      safeMeta[key] = typeof value === "string" ? value : JSON.stringify(value);
    }

    server.server
      .notification({
        method: "notifications/claude/channel",
        params: { content: msg.text, meta: safeMeta },
      })
      .catch((err) => {
        console.error(`cc-plugin: failed to forward push notification: ${err}`);
      });
  });

  return server;
}
