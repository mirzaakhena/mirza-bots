import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Engine } from "./engine/engine";
import { slashDirIn } from "./engine/paths";
import { writePending } from "./engine/slash/pending";
import { buildSlashPayload, MAX_SLASH_BATCH } from "./engine/slash/send-tool";
import { renderPeerStatuses } from "./engine/agent/status";

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
//
// Penandanya menamai SUMBER, bukan perilaku (keputusan user 2026-08-06).
// Sebelumnya bentuknya `[protocol: terse-turn]` -- satu-satunya penanda yang
// menyebut apa yang harus dilakukan, sementara tetangganya menyebut siapa
// pengirimnya. Ketidakkonsistenan itu tidak menggigit selama cuma ada dua; ia
// menggigit saat penulis ketiga (mesin) butuh nama, karena nama apa pun akan
// miring ke salah satu sumbu. Sumbu SUMBER yang dipilih karena mesin TAHU PASTI
// dari mana pesan datang dan TIDAK tahu perilaku apa yang pantas -- itu
// tergantung isi pesannya, dan itu wilayah AI.
export const USER_TURN_MARKER = "[from: user]";

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
export const AGENT_TURN_MARKER = "[from: agent]";

/**
 * Penanda untuk pengingat yang datang dari MESIN, bukan dari manusia maupun bot.
 *
 * Penulis ketiga (user 2026-08-06: *"mekanis mesin (system)"*). Ia tidak pernah
 * berdiri sendiri sebagai push: blok bertanda ini menempel pada pesan yang memang
 * sudah datang, karena mem-push pengingat sendirian berarti membangunkan AI tanpa
 * ada yang berbicara -- satu giliran penuh yang tidak diminta siapa pun.
 */
export const SYSTEM_TURN_MARKER = "[from: system]";

/**
 * Penanda mana yang dipasang di depan sebuah push. Murni, diekspor supaya bisa
 * diuji tanpa menyalakan server MCP.
 */
export function markerFor(meta: Record<string, string>): string {
  return meta.origin === "agent" ? AGENT_TURN_MARKER : USER_TURN_MARKER;
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
//
// NO INTERNAL SHORTHAND IN HERE. This text is shipped to the AI every session,
// and the AI cannot resolve project codes -- it has no BACKLOG to look them up
// in. A code like "AB-4 opsi B" therefore carries zero information to its actual
// reader while still being paid for in tokens; user caught one in this very
// paragraph on 2026-08-06. Traceability belongs in comments like this one, next
// to the rule, where it helps the humans who follow the trail:
//   - the inter-bot `reply` rule below is deliberately NOT enforced at the tool
//     level (AB-4 opsi B) -- the engine tags the outgoing message instead of
//     blocking it, because a bot going silent is the more expensive failure.
//   - the AFK wording in the first line duplicates hooks/reply-guard.ts on
//     purpose: the guard says it only AFTER the rule is broken, so the same
//     fact has to be stated up front where it can still prevent something.
//   - the third author (SYSTEM_TURN_MARKER) is named here as of 2026-08-09,
//     and it was missing from the day the marker was created. Nothing lied:
//     the opening sentence describes what LEADS a message, and only user and
//     agent ever lead one. What was wrong is the sentence right after it --
//     "the rules below are what each source means" -- while a third source
//     shipped with no meaning stated anywhere the AI could read. Two costs
//     followed, and both were paid silently:
//       * reminders.ts decided "mesin TIDAK menyusun prioritas, AI yang
//         menyusun, dan AI boleh mengembalikan keputusannya ke user". That is
//         an obligation placed ON the AI, and it lived only in a source
//         comment the AI never sees. Honoured by luck, not by design.
//       * the AI could not calibrate trust on a marker it was never told
//         exists. For the other two it at least knows the string means
//         something and can be sceptical when a user types one by hand.
/**
 * Satu blok teks di dalam `instructions`.
 *
 * `id` yang ADA berarti blok ini sebuah ATURAN, dan itu namanya. `id` yang
 * tidak ada berarti blok ini PENJELASAN, dan ia keluar apa adanya.
 *
 * Dua bentuk, bukan satu, dan itu keputusan (spec 2026-08-10 K-2): dari
 * sepuluh paragraf yang ada saat spec ditulis hanya lima yang benar-benar
 * aturan. Sisanya menerangkan -- siapa yang AFK, kenapa aturan antar-bot
 * sengaja tidak diblokir, apa arti penanda mesin. Melabeli penjelasan sebagai
 * `Rule` adalah berbohong kepada pembacanya, dan pembacanya BERTINDAK atas
 * label itu.
 */
export interface InstructionBlock {
  id?: string;
  text: string;
}

/**
 * Kenapa NAMA, bukan nomor (spec 2026-08-10 K-1).
 *
 * Usul awal user 2026-08-09 adalah `Rule #1`..`Rule #n`. Nomor bersifat
 * posisional: menyisipkan satu aturan di tengah membuat setiap rujukan `#3` di
 * hook, test, dan komentar menunjuk aturan yang salah -- DAN TIDAK ADA YANG
 * ERROR. Itu kelas kegagalan yang repo ini sudah punya doktrinnya (dua literal
 * yang harus sama akan menyimpang diam-diam), dan `engine/reminders.ts` sudah
 * memakai nama sejak awal, jadi konvensinya tinggal dipakai konsisten.
 *
 * Nama juga sudah menjelaskan dirinya: `no-prose` terbaca sebelum kalimat
 * aturannya dibaca, `#3` tidak pernah.
 */
export const INSTRUCTION_BLOCKS: InstructionBlock[] = [
  {
    text: `Every message pushed into this session starts with a marker that names where it came from -- ${USER_TURN_MARKER} or ${AGENT_TURN_MARKER}. A third marker, ${SYSTEM_TURN_MARKER}, never leads a message but can appear inside one. The marker says who sent it, never what to do about it; the rules below are what each source means. A rule carries a name of its own, and the machine uses that name when it tells you one was broken. A turn with no marker at all was typed by the user directly into this terminal, and is an ordinary turn.`,
  },
  {
    text: "Messages that arrive from Telegram appear in this session as notifications. The person who sent one is AFK -- away from this terminal, reading Telegram on their phone. They never see this transcript, so a `reply` tool call is the only thing that reaches them; your transcript output does not, however well written it is.",
  },
  // DIPECAH DUA (spec 2026-08-10 K-3). Sebelumnya satu paragraf memuat dua
  // kewajiban, sementara reply-guard sudah lama memperlakukannya sebagai dua
  // pelanggaran terpisah dengan dua pesan berbeda -- teksnya yang tertinggal,
  // bukan mesinnya. Satu id untuk dua kewajiban akan membuat catatan
  // pelanggaran tidak bisa membedakan "diam" dari "boros", dua kegagalan yang
  // obatnya berlawanan.
  {
    id: "reply-required",
    text: `When an incoming message is prefixed with ${USER_TURN_MARKER}, say everything you have to say through the \`reply\` tool. That call is the only thing that reaches the person: a turn that ends without one leaves them with silence they cannot tell apart from a broken bot.`,
  },
  {
    id: "no-prose",
    text: `On that same turn, do not also write prose into the transcript: end the turn with a single "." and nothing else. Never restate, summarize, or explain there what you already sent via \`reply\` -- nobody reads it, and it keeps costing tokens on every later turn of the session.`,
  },
  {
    text: "Both rules apply only to turns carrying that prefix. Turns the user types directly into this terminal are ordinary turns -- answer those in full, as usual.",
  },
  {
    id: "ack-first",
    text: "Send a short `reply` saying what you are about to do BEFORE your first tool call of the turn, and keep it to one line. They are AFK: while you work they see nothing at all, so they cannot tell whether you are working or hung, and the wait feels identical either way. Skip this only when your whole answer is text with no tool calls at all.",
  },
  {
    id: "reply-length",
    text: `Keep replies short: aim for about ${REPLY_LENGTH_GUIDELINE} characters. This is a chat on someone's phone, not a document. If a topic needs more room, send several focused \`reply\` calls that each stand on their own rather than one long block. Nothing is ever rejected for being long -- a reply past Telegram's hard limit is split into several messages automatically -- so this is about what is worth reading, not about what fits.`,
  },
  {
    id: "inter-bot-channel",
    text: `A message prefixed with ${AGENT_TURN_MARKER} came from ANOTHER BOT, not from the user. Do NOT answer it with \`reply\` -- that tool writes to the user's Telegram chat, and inter-bot traffic must stay off it. Answer with \`agent_send\` instead, addressed back to \`from_bot\`, with \`in_reply_to\` set to the \`agent_message_id\` from the meta and \`hop_count\` one higher than the incoming one.`,
  },
  {
    text: "That rule is not blocked at the tool level -- there are legitimate cases where a bot-to-bot exchange surfaces something only the user can decide, and `reply` staying silent would be worse than it speaking up. But know the consequence before you do it: if a turn triggered by an inter-bot message calls `reply` anyway, the engine automatically prepends a visible Indonesian marker to the outgoing text naming which bot triggered it -- you cannot suppress or edit it away. So the rule above still stands as the default; only reach for `reply` here when the user genuinely needs to see this, not as a shortcut.",
  },
  {
    id: "expects-reply-only",
    text: `Only reply to an inter-bot message when its meta says \`expects_reply: true\`. Anything else is one-way -- answering it anyway costs the other bot a turn it did not ask for. And a reply may never itself ask for a reply; that rule is enforced, not merely advised.`,
  },
  {
    text: `A block marked ${SYSTEM_TURN_MARKER} is written by the machine -- never by a person, never by another bot. It never arrives on its own: it is attached to a message that was already coming. It states a condition that is true RIGHT NOW rather than something that happened, so it stops appearing by itself once the condition no longer holds -- there is nothing to remember between turns. It does NOT rank what to do first: that judgment is yours, and you may hand it back to the user.`,
  },
];

/**
 * Nama setiap aturan, dalam urutan tulisnya. Diekspor untuk SATU pemakai: test
 * yang mengadu id yang dieja hook dengan id yang benar-benar ada di sini.
 *
 * Hook TIDAK boleh mengimpornya -- ia hanya boleh mengimpor `node:`, dan itu
 * terukur, bukan selera: versi pertama `hooks/session-start.ts` yang mengimpor
 * modul engine tidak pernah menyala sama sekali padahal terlihat terpasang.
 * Jadi salinan tidak terhindarkan; yang bisa dipilih hanyalah salinan yang
 * dijaga atau salinan yang tidak.
 */
export const RULE_IDS: string[] = INSTRUCTION_BLOCKS.flatMap((b) =>
  b.id === undefined ? [] : [b.id]
);

/**
 * Murni, supaya seluruh perakitannya bisa diuji tanpa menyalakan server MCP.
 *
 * Aturan diberi awalan `Rule <id>:` supaya rujukan dari hook punya tempat
 * mendarat: saat teguran berbunyi "you broke rule `no-prose`", kalimat aslinya
 * masih ada di context AI dan bisa dibaca ulang PERSIS, bukan lewat parafrase
 * yang bisa menyimpang.
 */
export function renderInstructions(blocks: InstructionBlock[]): string {
  return blocks.map((b) => (b.id === undefined ? b.text : `Rule ${b.id}: ${b.text}`)).join("\n\n");
}

export const SERVER_INSTRUCTIONS = renderInstructions(INSTRUCTION_BLOCKS);

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
    "agent_status",
    {
      description:
        "Report what each other bot on this machine is doing right now: online or not, the name of the session it is on, how full its context is, and HOW OLD that reading is. " +
        "Use it before handing work to another bot, so you pick one that can actually take it. " +
        "It answers with facts, not a verdict -- there is no `ready` flag, because whether a bot can take your work depends on what the work is, and you are the one who knows that. " +
        "Read the age of each reading before trusting it: the numbers come from the last time that bot's status line was drawn, so a quiet bot's reading can be hours old. " +
        "Everything is read from files. No other bot is contacted, interrupted, or woken up by this.",
      inputSchema: {},
    },
    async () => {
      if (isUnavailable(backend)) return unavailableAnswer(backend);
      return {
        content: [
          { type: "text" as const, text: renderPeerStatuses(backend.agentStatuses(), Date.now()) },
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
