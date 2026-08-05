import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Engine } from "./engine/engine";
import { slashDirIn } from "./engine/paths";
import { writePending } from "./engine/slash/pending";
import { buildSlashPayload, MAX_SLASH_BATCH } from "./engine/slash/send-tool";

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
 * Penanda untuk turn yang dipicu BOT LAIN, bukan Telegram.
 *
 * Ia ada untuk satu alasan mekanis: `reply-guard` hanya melihat teks
 * transcript, dan `origin.server` untuk pesan antar-bot memuat "cc-plugin"
 * persis seperti pesan Telegram -- penyempitan yang dulu memperbaiki W-14
 * (membatasi guard ke plugin sendiri) TIDAK menolong untuk sumber baru di dalam
 * plugin yang sama. Penandanya ditaruh di teks, karena di situlah guard bisa
 * melihatnya.
 *
 * ⚠️ Batas yang disadari: user bisa mengetik string ini lewat Telegram dan
 * membuat guard diam untuk satu pesan. Sekelas dengan `<channel source=...>`
 * yang sudah bisa dipalsukan sejak semula; konsekuensinya ringan, dan
 * dinyatakan di sini alih-alih disembunyikan.
 */
export const AGENT_TURN_MARKER = "[protocol: agent-turn]";

/**
 * Penanda mana yang dipasang di depan sebuah push. Murni, diekspor supaya bisa
 * diuji tanpa menyalakan server MCP.
 */
export function markerFor(meta: Record<string, string>): string {
  return meta.origin === "agent" ? AGENT_TURN_MARKER : TERSE_TURN_MARKER;
}

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
export function formatSendResult(result: {
  chars: number;
  parts: number;
  files: number;
}): string {
  const parts = result.parts > 1 ? ` in ${result.parts} parts` : "";
  const over =
    result.chars > REPLY_LENGTH_GUIDELINE ? `, over the ${REPLY_LENGTH_GUIDELINE} guideline` : "";
  const files = result.files > 0 ? `, ${result.files} file${result.files > 1 ? "s" : ""}` : "";
  return `sent (${result.chars} chars${parts}${over}${files})`;
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
  "",
  `A message prefixed with ${AGENT_TURN_MARKER} came from ANOTHER BOT, not from the user. Do NOT answer it with \`reply\` -- that tool writes to the user's Telegram chat, and inter-bot traffic must stay off it. Answer with \`agent_send\` instead, addressed back to \`from_bot\`, with \`in_reply_to\` set to the \`agent_message_id\` from the meta and \`hop_count\` one higher than the incoming one.`,
  "",
  `Only reply to an inter-bot message when its meta says \`expects_reply: true\`. Anything else is one-way -- answering it anyway costs the other bot a turn it did not ask for. And a reply may never itself ask for a reply; that rule is enforced, not merely advised.`,
].join("\n");

/**
 * `botHome` diterima terpisah dari `backend`, dan itu bukan kelebihan
 * parameter: tool `send_slash` harus tetap bekerja saat engine GAGAL start --
 * justru di situlah user paling butuh /clear atau /rename untuk memulihkan
 * sesinya. Kalau ia menumpang Engine, ia ikut mati bersamanya.
 */
export function buildServer(backend: ServerBackend, botHome: string): McpServer {
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
        "Attach files with `files`: an array of ABSOLUTE paths. Images (.jpg .jpeg .png .gif .webp) arrive as photos with an inline preview; anything else arrives as a document. Each file is its own Telegram message, sent after the text. `files` cannot be combined with `buttons` -- send the files first, then the buttons in a separate call. " +
        `Keep it short -- aim for about ${REPLY_LENGTH_GUIDELINE} characters. Long replies are split into several Telegram messages automatically, but that is a safety net, not a target: if the answer needs more room, send several focused \`reply\` calls that each stand on their own, rather than one long block.`,
      inputSchema: {
        text: z.string().min(1),
        buttons: z
          .array(z.array(z.object({ text: z.string().min(1), data: z.string().min(1) })))
          .optional(),
        reply_to: z.string().min(1).optional(),
        files: z.array(z.string().min(1)).optional(),
      },
    },
    async ({ text, buttons, reply_to, files }) => {
      if (isUnavailable(backend)) return unavailableAnswer(backend);
      const result = await backend.reply(text, buttons, reply_to, files);
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
        "Read stored conversation history around a Telegram message id. Use this when a message quotes or replies to an earlier one and you need what came before or after it -- the quoted message's id arrives as `reply_to_message_id` in a notification's meta. Always reads this session's own bot. " +
        "NEVER ask the user for a message id. They never see one: ids are an internal Telegram detail, not something a person can read off their screen. If you do not have an id, ask them to quote the message instead -- quoting delivers the id to you automatically. Do not print ids at them either.",
      inputSchema: {
        message_id: z.string().min(1),
        before: z.number().int().min(0).max(50).optional(),
        after: z.number().int().min(0).max(50).optional(),
      },
    },
    async ({ message_id, before, after }) => {
      if (isUnavailable(backend)) return unavailableAnswer(backend);
      const messages = await backend.history({
        messageId: message_id,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      });
      return { content: [{ type: "text", text: renderMessages(messages) }] };
    }
  );

  server.registerTool(
    "search_history",
    {
      description:
        "Search stored conversation history by keyword (SQLite FTS5). Always searches this session's own bot. Keep queries to plain words -- quotes and operators like AND/OR are rejected by the search engine.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, limit }) => {
      if (isUnavailable(backend)) return unavailableAnswer(backend);
      const messages = await backend.search({
        query,
        ...(limit !== undefined ? { limit } : {}),
      });
      return { content: [{ type: "text", text: renderMessages(messages) }] };
    }
  );

  server.registerTool(
    "agent_send",
    {
      description:
        "Send a message to ANOTHER BOT on this machine. This never touches Telegram: it does not appear on the user's phone, and it costs them nothing to read. " +
        "Address it by folder name -- every bot is a sibling folder, and `agent_list` tells you which names exist. " +
        "Set `expects_reply: true` only when you genuinely need an answer back, and only on a NEW message: a reply may not itself ask for a reply, and that rule is enforced, not advised. " +
        "When you are ANSWERING an inter-bot message, pass `in_reply_to` set to its `agent_message_id` and `hop_count` one higher than the one it arrived with. " +
        "If the target bot is not running, the message waits in its inbox folder until it is -- nothing is lost and nothing needs retrying.",
      inputSchema: {
        to: z.string().min(1),
        text: z.string().min(1),
        expects_reply: z.boolean().optional(),
        in_reply_to: z.string().min(1).optional(),
        hop_count: z.number().int().min(0).optional(),
      },
    },
    async ({ to, text, expects_reply, in_reply_to, hop_count }) => {
      if (isUnavailable(backend)) return unavailableAnswer(backend);
      const result = backend.agentSend(to, text, {
        ...(expects_reply !== undefined ? { expectsReply: expects_reply } : {}),
        ...(in_reply_to !== undefined ? { inReplyTo: in_reply_to } : {}),
        ...(hop_count !== undefined ? { hopCount: hop_count } : {}),
      });
      // Penolakan dijawab sebagai error, bukan sukses tanpa efek: "ditolak" dan
      // "terkirim" yang terlihat sama membuat AI mengira pesannya sedang
      // ditunggu bot lain padahal tidak pernah berangkat.
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
      }
      return {
        content: [
          { type: "text" as const, text: `titipan ${result.id} sudah masuk inbox ${to}` },
        ],
      };
    }
  );

  server.registerTool(
    "agent_list",
    {
      description:
        "List the other bots on this machine that you can reach with `agent_send`. The list is read from the parent folder every time -- there is no registry to fall out of date, and a folder counts as a bot when it contains config.json.",
      inputSchema: {},
    },
    async () => {
      if (isUnavailable(backend)) return unavailableAnswer(backend);
      const peers = backend.agentPeers();
      // Kalimat, bukan daftar kosong: "tidak ada tetangga" adalah keadaan sah
      // dan harus terbaca berbeda dari kegagalan membaca folder induk.
      const text =
        peers.length === 0
          ? "There are no other bots next to this one. Nothing to send to."
          : `Bots you can reach: ${peers.join(", ")}.`;
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // SENGAJA tidak menyentuh `backend`. Engine yang gagal start berarti Telegram
  // mati; tool ini cuma butuh tahu folder botnya, dan justru saat itulah user
  // paling butuh /clear atau /rename untuk memulihkan sesinya.
  server.registerTool(
    "send_slash",
    {
      description:
        "Send a slash command -- or an atomic BATCH of them -- to THIS session's own Claude Code. " +
        "Self-only by design: there is no target parameter, and there never will be. To have another bot run something, send it an `agent_send` message and let its own AI decide. " +
        "Only Claude Code's own commands work. Telegram-layer commands (`/new`, `/switch`, `/delete`, `/effort`) are rejected, each with its own true reason and where to go instead. " +
        "Pass `command` for one, or `commands` for an ordered batch (max " +
        MAX_SLASH_BATCH +
        "). A batch is written as ONE file and enqueued contiguously, so no other payload can interleave between its items -- use it for sequences like a handoff self-reset: [\"/rename done-...\", \"/clear\", \"/rename idle\"]. " +
        "Returns as soon as the command is queued; the wrapper injects the keystrokes on its next tick. Safe to call on your own initiative.",
      inputSchema: {
        command: z.string().min(1).optional(),
        commands: z.array(z.string().min(1)).optional(),
      },
    },
    async ({ command, commands }) => {
      const built = buildSlashPayload({
        ...(command !== undefined ? { command } : {}),
        ...(commands !== undefined ? { commands } : {}),
      });
      // Penolakan dijawab sebagai error, bukan sukses tanpa efek -- kalau
      // keduanya terlihat sama, AI mengira perintahnya sedang dikerjakan
      // padahal tidak pernah berangkat.
      if (!built.ok) {
        return { content: [{ type: "text" as const, text: built.message }], isError: true };
      }
      writePending(slashDirIn(botHome), built.payload, randomUUID());
      return { content: [{ type: "text" as const, text: built.ack }] };
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
        params: { content: `${markerFor(safeMeta)}\n${msg.text}`, meta: safeMeta },
      })
      .catch((err) => {
        console.error(`cc-plugin: failed to forward push notification: ${err}`);
      });
    });
  }

  return server;
}
