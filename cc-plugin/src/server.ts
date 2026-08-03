import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Engine } from "./engine/engine";

/**
 * What the server is when the engine could not start.
 *
 * It still registers every tool. A plugin that hides its tools on failure is
 * indistinguishable from one that was never installed, and that silence is the
 * failure this whole rewrite exists to end (W-16) -- so each tool answers with
 * the reason instead of not being there.
 */
export type Unavailable = { kind: "unavailable"; reason: string };
export type ServerBackend = Engine | Unavailable;

function isUnavailable(b: ServerBackend): b is Unavailable {
  return (b as Unavailable).kind === "unavailable";
}

function unavailableAnswer(b: Unavailable) {
  return {
    content: [{ type: "text" as const, text: `Telegram is not available: ${b.reason}` }],
    isError: true,
  };
}

// The single copy of this contract (K-15): the marker the push forwarder stamps
// onto Telegram-triggered turns, and the marker SERVER_INSTRUCTIONS teaches the
// AI to recognize. Two literals would drift apart silently -- the AI would keep
// looking for a marker that no longer arrives, and nothing anywhere would error.
export const TERSE_TURN_MARKER = "[protocol: terse-turn]";

/**
 * Panjang balasan yang disasar, dalam karakter.
 *
 * Bukan gerbang -- tidak ada yang ditolak karena kepanjangan, karena isi yang
 * hilang lebih buruk daripada isi yang panjang (keputusan user, 2026-08-02).
 * Angkanya dipilih dari sebaran nyata: 34% balasan 30 hari terakhir
 * melewatinya, cukup sering untuk menggigit tiap hari tanpa jadi mustahil.
 */
export const REPLY_LENGTH_GUIDELINE = 1000;

/**
 * Apa yang dilihat AI setelah `reply` berhasil.
 *
 * Dulu selalu "sent". Sebuah aturan yang tidak pernah membalas apa pun tidak
 * bisa dipelajari -- ini yang menutup jarak antara aturan yang ditulis dan
 * aturan yang terasa. Hanya AI yang melihat baris ini; user tidak.
 */
export function formatSendResult(result: { chars: number; parts: number }): string {
  const parts = result.parts > 1 ? ` in ${result.parts} parts` : "";
  const over =
    result.chars > REPLY_LENGTH_GUIDELINE ? `, over the ${REPLY_LENGTH_GUIDELINE} guideline` : "";
  return `sent (${result.chars} chars${parts}${over})`;
}

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
  "",
  `Keep replies short: aim for about ${REPLY_LENGTH_GUIDELINE} characters. This is a chat on someone's phone, not a document. If a topic needs more room, send several focused \`reply\` calls that each stand on their own rather than one long block. Nothing is ever rejected for being long -- a reply past Telegram's hard limit is split into several messages automatically -- so this is about what is worth reading, not about what fits.`,
].join("\n");

export function buildServer(backend: ServerBackend): McpServer {
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
        "Send a reply message to the user on Telegram. Write ordinary markdown -- **bold**, *italic*, `code`, fenced blocks, links -- it is converted for you; there is no format flag to remember. " +
        "Optionally attach inline keyboard buttons as rows of {text, data} -- pressing a button delivers `data` back as the user's next message. " +
        "Pass `reply_to` with a Telegram message id to quote that message, e.g. when answering something said a while ago and the thread has moved on. " +
        "NEVER ask the user for a message id. They never see one: ids are an internal Telegram detail, not something a person can read off their screen. If you do not have an id, ask them to quote the message instead -- quoting delivers the id to you automatically. " +
        `Keep it short -- aim for about ${REPLY_LENGTH_GUIDELINE} characters. Long replies are split into several Telegram messages automatically, but that is a safety net, not a target: if the answer needs more room, send several focused \`reply\` calls that each stand on their own, rather than one long block.`,
      inputSchema: {
        text: z.string().min(1),
        buttons: z
          .array(z.array(z.object({ text: z.string().min(1), data: z.string().min(1) })))
          .optional(),
        reply_to: z.string().min(1).optional(),
      },
    },
    async ({ text, buttons, reply_to }) => {
      if (isUnavailable(backend)) return unavailableAnswer(backend);
      const result = await backend.reply(text, buttons, reply_to);
      return { content: [{ type: "text", text: formatSendResult(result) }] };
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
        "Read stored conversation history around a Telegram message id. Use this when a message quotes or replies to an earlier one and you need what came before or after it -- the quoted message's id arrives as `reply_to_message_id` in a notification's meta. Defaults to this session's own bot; pass `bot` only when deliberately looking at another bot's conversation. " +
        "NEVER ask the user for a message id. They never see one: ids are an internal Telegram detail, not something a person can read off their screen. If you do not have an id, ask them to quote the message instead -- quoting delivers the id to you automatically. Do not print ids at them either.",
      inputSchema: {
        message_id: z.string().min(1),
        before: z.number().int().min(0).max(50).optional(),
        after: z.number().int().min(0).max(50).optional(),
        bot: z.string().min(1).optional(),
      },
    },
    async ({ message_id, before, after, bot }) => {
      if (isUnavailable(backend)) return unavailableAnswer(backend);
      const messages = await backend.history({
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
      if (isUnavailable(backend)) return unavailableAnswer(backend);
      const messages = await backend.search({
        query,
        ...(limit !== undefined ? { limit } : {}),
        ...(bot !== undefined ? { bot } : {}),
      });
      return { content: [{ type: "text", text: renderMessages(messages) }] };
    }
  );

  if (!isUnavailable(backend)) {
    backend.onPush((msg) => {
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
  }

  return server;
}
