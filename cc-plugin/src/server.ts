import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FleetdClient } from "./fleetd-client";

// The single copy of this contract (K-15): the marker the push forwarder stamps
// onto Telegram-triggered turns, and the marker SERVER_INSTRUCTIONS teaches the
// AI to recognize. Two literals would drift apart silently -- the AI would keep
// looking for a marker that no longer arrives, and nothing anywhere would error.
export const TERSE_TURN_MARKER = "[protocol: terse-turn]";

// Lives in the MCP server's `instructions`, which Claude Code holds for the
// whole session: paid once, not once per turn. English on purpose (K-16 -- this
// is a machine-to-AI instruction, not a message to the user); the AI's `reply`
// content still follows the user's own language.
export const SERVER_INSTRUCTIONS = [
  "Messages from Telegram arrive in this session as notifications. The person you are talking to reads Telegram, not this transcript: the ONLY thing that reaches them is a `reply` tool call. Your transcript output reaches nobody.",
  "",
  `When an incoming message is prefixed with ${TERSE_TURN_MARKER}, do not write prose in that turn. Say everything you have to say through the \`reply\` tool, then end the turn with a single "." and nothing else. Never restate, summarize, or explain in the transcript what you already sent via \`reply\` -- nobody reads it, and it keeps costing tokens on every later turn of the session.`,
  "",
  "This applies only to turns carrying that prefix. Turns the user types directly into this terminal are ordinary turns -- answer those in full, as usual.",
].join("\n");

export function buildServer(client: FleetdClient): McpServer {
  const server = new McpServer(
    { name: "cc-plugin", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        // Without this, Claude Code silently drops every
        // notifications/claude/channel push below -- the session never even
        // sees an error, the message just never arrives.
        experimental: { "claude/channel": {} },
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

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
    //
    // NOTE: the fallback must be String(value), not JSON.stringify(value) --
    // JSON.stringify(undefined) returns the *value* undefined, not the string
    // "undefined", which would silently reintroduce the exact bug this
    // forwarder exists to prevent. String(value) is always a string for any
    // input, including undefined and null.
    const safeMeta: Record<string, string> = {};
    for (const [key, value] of Object.entries(msg.meta)) {
      safeMeta[key] = typeof value === "string" ? value : String(value);
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
