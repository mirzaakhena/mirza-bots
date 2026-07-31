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
  "Messages that arrive from Telegram appear in this session as notifications. The person who sent them is reading Telegram, not this transcript, so a `reply` tool call is the only thing that reaches them -- your transcript output does not.",
  "",
  `When an incoming message is prefixed with ${TERSE_TURN_MARKER}, do not write prose in that turn. Say everything you have to say through the \`reply\` tool, then end the turn with a single "." and nothing else. Never restate, summarize, or explain in the transcript what you already sent via \`reply\` -- nobody reads it, and it keeps costing tokens on every later turn of the session.`,
  "",
  "This applies only to turns carrying that prefix. Turns the user types directly into this terminal are ordinary turns -- answer those in full, as usual.",
].join("\n");

export function buildServer(client: FleetdClient): McpServer {
  const server = new McpServer(
    // "version" here is the MCP protocol identity of this server, not the
    // plugin/package version -- it is deliberately independent of
    // plugin.json / package.json (which have moved on ahead of this) and
    // nothing reads it. Do not "fix" this to match the manifest version.
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

  // Renders history rows for the AI. JSON rather than prose: this is data the AI
  // asked for, and it must be visibly data. Note that the rows contain the
  // sender's own words -- that is fine here and is NOT the SCAR-088 case, which
  // is about sender text arriving as the incoming message being acted on.
  const renderMessages = (messages: unknown[]) =>
    messages.length === 0 ? "No messages found." : JSON.stringify(messages, null, 2);

  server.registerTool(
    "read_history",
    {
      description:
        "Read stored conversation history around a Telegram message id. Use this when a message quotes or replies to an earlier one and you need what came before or after it -- the quoted message's id arrives as `reply_to_message_id` in a notification's meta. Defaults to this session's own bot; pass `bot` only when deliberately looking at another bot's conversation.",
      inputSchema: {
        message_id: z.string().min(1),
        before: z.number().int().min(0).max(50).optional(),
        after: z.number().int().min(0).max(50).optional(),
        bot: z.string().min(1).optional(),
      },
    },
    async ({ message_id, before, after, bot }) => {
      const messages = await client.history({
        messageId: message_id,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(bot !== undefined ? { bot } : {}),
      });
      return { content: [{ type: "text", text: renderMessages(messages) }] };
    }
  );

  server.registerTool(
    "search_history",
    {
      description:
        "Search stored conversation history by keyword (SQLite FTS5). Defaults to this session's own bot; pass `bot` only when deliberately searching another bot's conversation. Keep queries to plain words -- quotes and operators like AND/OR are rejected by the search engine.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        bot: z.string().min(1).optional(),
      },
    },
    async ({ query, limit, bot }) => {
      const messages = await client.search({
        query,
        ...(limit !== undefined ? { limit } : {}),
        ...(bot !== undefined ? { bot } : {}),
      });
      return { content: [{ type: "text", text: renderMessages(messages) }] };
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
        // The marker is the ONLY signal that distinguishes a Telegram-driven
        // turn from one the user typed in the terminal -- and it needs no flag
        // or stored state, because this callback is the sole path a Telegram
        // message can take into the session. The old system used a session-wide
        // `telegramDriven` flag for the same job and it went sticky: once a
        // session had ever seen a Telegram message, terminal-typed turns were
        // misclassified too (audit area-10 §10.2).
        params: { content: `${TERSE_TURN_MARKER}\n${msg.text}`, meta: safeMeta },
      })
      .catch((err) => {
        console.error(`cc-plugin: failed to forward push notification: ${err}`);
      });
  });

  return server;
}
