import type { Context, Filter, InlineKeyboard } from "grammy";
import { InputFile } from "grammy";
import type { Database } from "bun:sqlite";
import { statSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  ensureBotDirs,
  configPathIn,
  conversationsDbPathIn,
  dataDirIn,
  botPidPathIn,
  statusPathIn,
  chainedStatuslinePathIn,
} from "./paths";
import { installBridge, buildBridgeCommand, pluginRootFrom } from "./context/install";
import { readCapturedStatus } from "./context/status-file";
import { readSessionNameFromTranscript } from "./context/session-title";
import { replyStored, type ReplyableCtx } from "./reply-stored";
import { renderContext } from "./context/render";
import { waitForCapture } from "./context/wait";
import { loadConfig } from "./config";
import { identifyBot } from "./identity";
import { startInboxScanner, AGENT_ORIGIN } from "./agent/receive";
import { sendToPeer, type SendResult } from "./agent/send";
import { listPeers } from "./agent/peers";
import { buildReminderContext, collectReminders, renderReminders } from "./reminders";
import { summarizePeer, pidFrom, type PeerStatus } from "./agent/status";
import { acquireBotLock, releaseBotLock } from "./lock";
import {
  openConversationsDb,
  insertMessage,
  encodeMetadata,
  getLastChatId,
  countUserTurns,
  rememberFirstSessionName,
  rememberNotifiedSessionName,
  getNotifiedSessionName,
  getFirstSessionName,
} from "./db/conversations-schema";
import { AlbumBuffer } from "./telegram/album-buffer";
import { extractQuote } from "./telegram/quote";
import { safeName, MAX_DOCUMENT_BYTES } from "./telegram/media";
import {
  startPolling,
  type IncomingOptions,
  type NormalizedMessage,
  type PollerDeps,
} from "./telegram/poller";
import { classify } from "./slash/classify";
import { buildCommandMenu } from "./slash/menu";
import {
  handleSlash,
  handleConfirm,
  parseSlashCallback,
  SLASH_CALLBACK_GO,
  SLASH_CALLBACK_CANCEL,
} from "./slash";
import {
  makeBot,
  fileUrl,
  normalizeMessage,
  buildAlbumMessage,
  buildTappedMessageEdit,
  deliverIncoming,
  findMissingButtonNarration,
  buildInlineKeyboard,
  handleHistoryRequest,
  handleSearchRequest,
} from "./messages";
import type { MessageSink, PushMessage } from "./sink";
import { readCurrentSessionId } from "./session-file";
import { renderSessionNotice, shouldNotifyRename, type SessionNotice } from "./session-notice";
import type { ButtonRow, HistoryMessage } from "./types";
import { planParts, type OutboundPart } from "./chunk";
import { planAttachments, type PlannedAttachment } from "./attach";
import { createTypingKeepalive } from "./typing";

/** Apa yang benar-benar terkirim -- dipakai server untuk memberi umpan balik ke AI. */
export interface ReplyResult {
  /** Panjang CommonMark yang ditulis AI, bukan panjang setelah escaping. */
  chars: number;
  /** Berapa pesan Telegram yang keluar. 1 untuk sebagian besar balasan. */
  parts: number;
  /** Berapa berkas ikut terkirim. 0 untuk balasan teks biasa. */
  files: number;
}

/**
 * Everything cc-plugin needs from the Telegram side, in the shape its MCP tools
 * already expect.
 *
 * Deliberately identical to the old FleetdClient surface: the socket is being
 * removed, not the contract, and server.ts should not have to know which one it
 * is talking to. The one deliberate exception: `reply` now returns a
 * `ReplyResult` instead of `void`, so the caller can report chars/parts back to
 * the AI -- every other member is unchanged.
 */
export type Engine = {
  bot: string;
  reply(
    text: string,
    buttons?: ButtonRow[],
    replyTo?: string,
    files?: string[]
  ): Promise<ReplyResult>;
  history(opts: { messageId: string; before?: number; after?: number }): Promise<HistoryMessage[]>;
  search(opts: { query: string; limit?: number }): Promise<HistoryMessage[]>;
  /** Menitipkan satu pesan ke inbox bot tetangga. TIDAK menyentuh Telegram. */
  agentSend(
    to: string,
    text: string,
    opts: { expectsReply?: boolean; inReplyTo?: string; hopCount?: number }
  ): SendResult;
  /** Nama bot tetangga yang benar-benar ada, dibaca dari folder induk. */
  agentPeers(): string[];
  /** Keadaan tiap tetangga: fakta dari berkasnya, tanpa penilaian siap/tidak. */
  agentStatuses(): PeerStatus[];
  onPush(handler: (msg: PushMessage) => void): void;
  close(): void;
};

export type EngineStart = { ok: true; engine: Engine } | { ok: false; message: string };

/**
 * Assembles one bot's engine inside the calling process.
 *
 * Two things differ from the daemon this replaces:
 *
 *  - it polls exactly ONE bot: the folder it was handed. Tidak ada lagi
 *    `config.bots` untuk diiterasi, dan tidak ada lagi config maupun database
 *    bersama -- folder itu SENDIRI yang memuat token, riwayat, lock, dan
 *    statusnya. "Bot mana aku?" dijawab nama folder, bukan pencocokan path.
 *
 *  - every failure comes back as a sentence, never thrown. A thrown startup
 *    error is precisely what made cc-plugin vanish without a word (W-16), and a
 *    process that dies before it can speak leaves nothing to diagnose. The
 *    caller is expected to keep serving its tools and report this message
 *    through them.
 */

/**
 * Records a reply that Telegram has already accepted.
 *
 * Exported for tests, and called only AFTER sendMessage resolves. Two reasons,
 * both load bearing:
 *  - `message_id` exists ONLY in Telegram's answer. Storing first means storing
 *    a row with no id, and an id-less row can never be quoted later.
 *  - storing first would also record messages that were never delivered.
 *
 * The text stored is the AI's ORIGINAL CommonMark, not the MarkdownV2 the wire
 * carried. What the AI re-reads later must be what it wrote, not the escaped
 * form -- history full of backslashes would be worse than no history.
 */
export function storeOutgoing(
  db: Database,
  msg: {
    bot: string;
    chatId: string;
    messageId?: string;
    text?: string;
    sessionId?: string;
    replyTo?: string;
    /** Path berkas yang pesan ini bawa. Satu baris per berkas, jadi selalu berisi satu. */
    attachments?: string[];
    kind?: "photo" | "document";
  }
): void {
  insertMessage(db, {
    ts: new Date().toISOString(),
    bot: msg.bot,
    chatId: msg.chatId,
    messageId: msg.messageId,
    source: "assistant",
    text: msg.text,
    replyTo: msg.replyTo,
    sessionId: msg.sessionId,
    attachments: msg.attachments ? JSON.stringify(msg.attachments) : undefined,
    // encodeMetadata mengembalikan undefined kalau tidak ada isinya, sehingga
    // kolomnya NULL alih-alih string "{}" -- yang akan memaksa setiap pembaca
    // nanti memperlakukannya sebagai kasus khusus "ada tapi kosong".
    metadata: encodeMetadata({ ...(msg.kind !== undefined ? { kind: msg.kind } : {}) }),
  });
}

/**
 * Assembles sendMessage's options object.
 *
 * Split out so the quoting rules are testable without a bot, and so "nothing to
 * say" produces NO object rather than an empty one: grammy forwards this as-is,
 * and a present-but-empty `reply_parameters` is a 400 from Telegram.
 */
export function buildSendOptions(
  replyMarkup: InlineKeyboard | undefined,
  replyTo: string | undefined
): { reply_markup?: InlineKeyboard; reply_parameters?: { message_id: number } } | undefined {
  const opts: { reply_markup?: InlineKeyboard; reply_parameters?: { message_id: number } } = {};
  if (replyMarkup) opts.reply_markup = replyMarkup;
  if (replyTo !== undefined) {
    const id = Number(replyTo);
    if (!Number.isInteger(id)) {
      // Named here rather than left to Telegram's opaque 400, and the U-3 rule
      // is repeated in the message because this is exactly the moment an AI is
      // tempted to go ask the human for an id they have never seen.
      throw new Error(
        `reply_to must be a Telegram message id (a number); got "${replyTo}". ` +
          `Ids arrive in a notification's meta as message_id or reply_to_message_id -- ` +
          `never ask the user for one; ask them to quote the message instead.`
      );
    }
    opts.reply_parameters = { message_id: id };
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Opsi kirim untuk potongan ke-`index` dari `total`.
 *
 * Aturannya dua, dan keduanya punya alasan yang terlihat di layar user:
 * tombol hanya di potongan TERAKHIR (di tengah, keyboard menggantung di atas
 * teks lanjutan), kutipan hanya di potongan PERTAMA (yang dijawab adalah
 * balasannya secara keseluruhan).
 *
 * Dipisah jadi fungsi sendiri supaya kedua aturan itu bisa diuji tanpa
 * menyentuh jaringan.
 */
export function planSendOptionsFor(
  index: number,
  total: number,
  replyMarkup: InlineKeyboard | undefined,
  replyTo: string | undefined
): { reply_markup?: InlineKeyboard; reply_parameters?: { message_id: number } } | undefined {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  return buildSendOptions(isLast ? replyMarkup : undefined, isFirst ? replyTo : undefined);
}

/**
 * Bagian API Telegram yang dibutuhkan pengiriman berkas -- dua metode, bukan
 * seluruh objek grammy, supaya test tidak perlu bot sungguhan.
 */
export type AttachmentApi = {
  sendPhoto(chatId: string, file: unknown): Promise<{ message_id: number }>;
  sendDocument(chatId: string, file: unknown): Promise<{ message_id: number }>;
};

/**
 * Mengirim berkas satu per satu, berurutan.
 *
 * `onSent` dipanggil sesudah TIAP kiriman sukses, bukan sekali di akhir: kalau
 * berkas ketiga meledak, dua yang pertama sudah ada di HP user dan barisnya
 * harus tetap tercatat.
 *
 * `toInput` menyuntikkan pembungkus berkas grammy (`InputFile`) supaya seluruh
 * urutan kirim di sini bisa diuji tanpa menyentuh filesystem maupun jaringan.
 */
export async function sendAttachments(
  api: AttachmentApi,
  chatId: string,
  planned: PlannedAttachment[],
  toInput: (path: string) => unknown,
  onSent: (a: PlannedAttachment, messageId: string) => void
): Promise<number> {
  let sent = 0;
  for (const a of planned) {
    let msg;
    try {
      const input = toInput(a.path);
      msg =
        a.kind === "photo"
          ? await api.sendPhoto(chatId, input)
          : await api.sendDocument(chatId, input);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // "text already delivered" ada supaya pemanggilnya tahu mengirim ulang
      // seluruh balasan akan menggandakan teksnya.
      throw new Error(
        `reply failed after ${sent} of ${planned.length} attachment(s) sent (text already delivered): ${reason}`
      );
    }
    sent++;
    onSent(a, String(msg.message_id));
  }
  return sent;
}

/**
 * Menolak `buttons` dan `files` dalam satu panggilan.
 *
 * Bukan batasan teknis: berkas dikirim sesudah teks, jadi keyboardnya menempel
 * pada pesan yang sekarang berada di ATAS berkas-berkasnya. User harus menggulir
 * balik ke atas untuk menekan tombol yang seharusnya jadi langkah berikutnya.
 */
export function assertNoButtonsWithFiles(
  buttons: ButtonRow[] | undefined,
  files: string[] | undefined
): void {
  if (buttons !== undefined && buttons.length > 0 && files !== undefined && files.length > 0) {
    throw new Error(
      "buttons and files cannot be combined in one reply: send the files first, then the buttons in a separate reply call"
    );
  }
}

/**
 * SEMUA yang harus terjadi sebelum satu byte pun berangkat ke Telegram.
 *
 * Dikumpulkan jadi satu fungsi dengan sengaja. Kontrak terpenting fitur ini --
 * *path yang salah ketik tidak boleh meninggalkan teks yang sudah mendarat* --
 * adalah soal URUTAN, dan urutan yang dijaga oleh tiga baris berjejer di dalam
 * `reply` hanya bertahan selama orang berikutnya yang menyunting fungsi itu
 * mengingat kenapa. Satu panggilan di atas loop pengiriman menjadikannya
 * struktur, bukan ingatan.
 *
 * `sizeOf` disuntik supaya seluruh pagarnya bisa diuji tanpa filesystem.
 */
export function prepareReply(
  text: string,
  buttons: ButtonRow[] | undefined,
  files: string[] | undefined,
  sizeOf: (path: string) => number
): { parts: OutboundPart[]; planned: PlannedAttachment[] } {
  // Membaca teks AI sebelum escaping MarkdownV2 dan sebelum pemotongan --
  // alasan lengkapnya di komentar findMissingButtonNarration.
  const unnarrated = findMissingButtonNarration(text, buttons);
  if (unnarrated) throw new Error(unnarrated);

  assertNoButtonsWithFiles(buttons, files);

  const planned = files !== undefined && files.length > 0 ? planAttachments(files, sizeOf) : [];

  return { parts: planParts(text), planned };
}

/**
 * AB-4 opsi B -- "siapa yang TERAKHIR mengirim push ke sesi ini".
 *
 * SENGAJA bukan flag yang sekali menyala tidak pernah padam. Sistem lama
 * (`telegramDriven`) adalah flag begitu, dan ia nyangkut: sekali sebuah sesi
 * pernah menyentuh Telegram, giliran yang diketik langsung di terminal pun
 * ikut salah diklasifikasi (audit area-10 §10.2). Bentuk yang benar adalah
 * "siapa bicara TERAKHIR", dan itu berganti tiap push masuk -- push user
 * berikutnya SELALU mengembalikannya ke "user", apa pun yang terjadi sebelum
 * itu. Lihat `nextPushOrigin` di bawah untuk aturan resetnya, dan komentar di
 * `sink.push` (di dalam `startEngine`) untuk di mana ia benar-benar dipanggil.
 */
export type LastPushOrigin = { kind: "user" } | { kind: "agent"; fromBot: string };

/**
 * Origin BERIKUTNYA sesudah satu push baru masuk. Murni dan diekspor supaya
 * aturan reset-nya bisa diuji tanpa menyalakan engine sama sekali.
 *
 * `meta.origin === AGENT_ORIGIN` adalah SATU-SATUNYA sinyal, dan itu konstanta
 * yang sama dipakai `markerFor` di server.ts -- kedua tempat tidak bisa
 * diam-diam berbeda pendapat soal pesan mana yang "dari bot lain".
 *
 * Setiap push yang BUKAN agent (termasuk yang metanya entah bagaimana rusak
 * atau tidak lengkap) jatuh ke "user", jadi arah defaultnya adalah TIDAK
 * menandai. Itu disengaja, dan alasannya sama persis dengan `markerFor` di
 * server.ts: `meta.origin` ditulis oleh jalur antar-bot itu sendiri, bukan
 * oleh siapa pun di luar, jadi "bukan agent" bukan keadaan ragu-ragu -- ia
 * memang bukan pesan antar-bot. Menebak ke arah sebaliknya akan menandai
 * balasan biasa milik user, dan itu kasus mayoritas mutlak; membuatnya
 * berisik merugikan setiap hari demi kasus yang tidak pernah terjadi.
 *
 * Konsekuensi yang diterima sadar: kalau suatu hari `meta.origin` benar-benar
 * hilang di jalur antar-bot, balasannya lolos TANPA penanda. Yang menjaga itu
 * bukan default di sini melainkan `AGENT_ORIGIN` sebagai konstanta bersama --
 * satu-satunya sumber, dipakai di kedua tempat.
 */
export function nextPushOrigin(meta: Record<string, string>): LastPushOrigin {
  return meta.origin === AGENT_ORIGIN
    ? { kind: "agent", fromBot: meta.from_bot ?? "bot lain" }
    : { kind: "user" };
}

/**
 * Baris penanda yang WAJIB nempel di depan `reply` ketika origin TERAKHIR
 * sesi ini adalah bot lain -- ditegakkan di sini, di kode, bukan dititipkan ke
 * kesopanan AI (itulah inti AB-4 opsi B: dua kejadian produksi 2026-08-05
 * membuktikan AI SUDAH menyebut sumbernya sendiri secara sukarela, jadi yang
 * dicabut hanya ketergantungannya pada niat baik, bukan perilakunya).
 *
 * Bahasa Indonesia dengan sengaja: baris ini dibaca USER di Telegram, bukan
 * AI -- beda dari SERVER_INSTRUCTIONS (server.ts) yang bahasa Inggris (K-16).
 *
 * `null` untuk giliran biasa (dipicu user) -- kasus mayoritas mutlak, dan
 * `reply` tidak boleh menambah apa pun untuknya kalau ia tidak mau jadi
 * berisik dan merugikan justru fitur ini sendiri.
 *
 * ⚠️ Batas yang disadari, bukan disembunyikan: kalau user mengetik langsung
 * di terminal sesi bot (bukan lewat Telegram) SESUDAH sebuah pesan antar-bot
 * masuk, dan menyuruh `reply` membalas, balasan itu TETAP akan ditandai --
 * padahal user sendiri yang meminta. Ini false positive yang TERLIHAT
 * (bukan kegagalan diam-diam), dan arahnya dipilih begitu dengan sengaja:
 * menandai berlebihan hanya bikin berisik, sementara gagal menandai
 * mengembalikan persis masalah yang perubahan ini ada untuk menutupnya.
 */
export function buildAgentOriginMarker(origin: LastPushOrigin): string | null {
  return origin.kind === "agent"
    ? `🤖 Dipicu oleh bot lain (${origin.fromBot}), bukan oleh pesanmu.`
    : null;
}

export function startEngine(botHome: string): EngineStart {
  // Identitas DULU, config belakangan. Folder yang bukan bot harus dijawab
  // "ini bukan folder bot", bukan "config tidak bisa dibaca" -- yang kedua
  // terdengar seperti kerusakan padahal keadaannya sah.
  const identity = identifyBot(botHome, existsSync(configPathIn(botHome)));
  if (!identity.ok) return { ok: false, message: identity.message };
  const botName = identity.bot;

  let config;
  try {
    ensureBotDirs(botHome);
    config = loadConfig(configPathIn(botHome));
  } catch (err) {
    return { ok: false, message: `Cannot read this bot's config: ${(err as Error).message}` };
  }

  // Penyembuhan bridge SAAT START, bukan cuma saat /context dipanggil.
  // Kambuh dua kali (2026-08-04, 2026-08-05): path bridge menyematkan nomor
  // versi, jadi tiap `claude plugin update` membuatnya basi, dan sebelum
  // perubahan ini path itu tetap basi sampai kebetulan ada yang menjalankan
  // /context -- bisa berhari-hari.
  //
  // Deps di bawah SAMA PERSIS dengan yang dipakai replyLocalContext (lihat
  // situ) -- disengaja, tidak disusun ulang: dua sumber untuk satu fakta yang
  // sama selalu bisa diam-diam berbeda pendapat.
  //
  // Kegagalan di sini TIDAK BOLEH menggagalkan start: statusline cuma
  // kenyamanan, Telegram adalah tugas utamanya. Kalau installBridge menjawab
  // "refused" atau "rolled-back", alasannya dicatat ke stderr (W-16, diam-diam
  // gagal adalah kegagalan yang paling dihukum) -- operator yang membaca log
  // proses tahu kenapa, sementara /context tetap jadi jalur yang melapor ke
  // USER lewat Telegram.
  const bridgeInstall = installBridge({
    projectDir: botHome,
    userSettingsPath: join(homedir(), ".claude", "settings.json"),
    bridgeCommand: buildBridgeCommand(
      pluginRootFrom(process.env.CLAUDE_PLUGIN_ROOT, import.meta.url)
    ),
    chainPath: chainedStatuslinePathIn(botHome),
  });
  if (bridgeInstall.kind === "refused" || bridgeInstall.kind === "rolled-back") {
    console.error(
      `cc-plugin: bridge statusline tidak dipasang/diperbarui saat start -- ${bridgeInstall.reason}`
    );
  }

  const takeover = acquireBotLock(botPidPathIn(botHome), process.pid);
  if (takeover.previousPid !== null) {
    // Said out loud on purpose: from the older session's side this looks like
    // Telegram going quiet for no reason, and that silence is indistinguishable
    // from a broken bot unless somebody names it.
    console.error(
      `cc-plugin: took the ${botName} token over from pid ${takeover.previousPid}; ` +
        `that session stops receiving Telegram messages.`
    );
  }

  const conversationsDb = openConversationsDb(conversationsDbPathIn(botHome));

  // Held until onPush registers a handler rather than dropped: polling starts
  // before the MCP server finishes connecting, and losing that window would look
  // exactly like the bot ignoring the first message after startup.
  const buffered: PushMessage[] = [];
  let handler: ((msg: PushMessage) => void) | undefined;

  // AB-4 opsi B: "siapa yang terakhir bicara ke sesi ini". Lihat komentar di
  // atas nextPushOrigin/buildAgentOriginMarker untuk kenapa ia BUKAN flag.
  let lastPushOrigin: LastPushOrigin = { kind: "user" };

  const sink: MessageSink = {
    push: (msg) => {
      // Diperbarui DI SINI, bukan di deliverIncoming: pesan antar-bot
      // (drainInbox, agent/receive.ts) tidak pernah lewat deliverIncoming sama
      // sekali -- ia mendorong langsung ke sink.push. `sink.push` adalah
      // satu-satunya titik yang benar-benar dilewati SETIAP push, baik dari
      // user (lewat poller Telegram) maupun dari bot lain (lewat inbox), jadi
      // di sinilah "push terakhir" harus dicatat. Diperbarui SEBELUM
      // handler/buffered supaya reply yang terjadi sebelum onPush terdaftar
      // pun tetap melihat origin yang benar.
      lastPushOrigin = nextPushOrigin(msg.meta);
      return handler ? handler(msg) : buffered.push(msg);
    },
    // Read per push, never captured: /clear replaces the session without
    // restarting this process. See session-file.ts for the measurement.
    sessionId: () => readCurrentSessionId(botHome),
  };

  // Kotak surat antar-bot. Dinyalakan bersama engine dan berhenti bersamanya:
  // pesan yang datang saat bot mati menunggu di folder, dan `ls inbox/`
  // memperlihatkannya tanpa query apa pun.
  const stopInboxScanner = startInboxScanner(botHome, sink);

  const bot = makeBot(config.token);

  // Indikator "typing...". Pakai `bot.api` langsung, bukan lewat helper kirim
  // apa pun: ini bukan pesan, tidak disimpan ke riwayat, dan tidak boleh ikut
  // jalur mana pun yang punya efek samping.
  const typing = createTypingKeepalive({
    // `await`, bukan mengembalikan langsung: sendChatAction menjawab
    // Promise<true>, dan kontrak `send` adalah Promise<void>. bun test tidak
    // memeriksa tipe, jadi ketidakcocokan ini hidup tenang sampai tsc dipasang.
    send: async chatId => {
      await bot.api.sendChatAction(chatId, "typing");
    },
  });

  const deps: PollerDeps = {
    config,
    conversationsDb,
    sink,
    dataDir: dataDirIn(botHome),
    // Dirakit di sini, bukan di poller: seluruh pengetahuan tentang berkas
    // tinggal di satu tempat, dan poller tetap bisa diuji tanpa disk.
    //
    // Dibaca ULANG tiap pesan, bukan sekali saat start. Itu inti dari "pemicu
    // adalah keadaan": nama sesi dan jumlah giliran berubah SELAMA sesi hidup,
    // dan nilai yang diambil sekali di awal akan menjawab pertanyaan hari ini
    // dengan keadaan kemarin.
    systemReminders: (sessionId) => {
      if (sessionId === undefined) return "";
      try {
        const captured = readCapturedStatus(statusPathIn(botHome));

        // Nama saat sesi ini LAHIR dicatat sekali, dan hanya dari tangkapan
        // yang benar-benar milik sesi ini. Kalau tangkapannya masih milik sesi
        // sebelumnya, mencatatnya berarti mengabadikan nama yang salah sebagai
        // pembanding -- dan pembanding yang salah tidak akan pernah ketahuan,
        // karena hasilnya tetap terlihat masuk akal.
        if (captured?.payload?.session_id === sessionId) {
          rememberFirstSessionName(conversationsDb, sessionId, captured.payload.session_name ?? "");
        }

        const ctx = buildReminderContext(
          captured,
          sessionId,
          countUserTurns(conversationsDb, sessionId),
          getFirstSessionName(conversationsDb, sessionId)
        );
        return renderReminders(collectReminders(ctx));
      } catch (err) {
        // Pengingat tidak boleh pernah menjadi alasan sebuah pesan tidak
        // sampai. Yang hilang cuma pengingatnya, dan giliran berikutnya
        // membawanya lagi.
        console.error(`cc-plugin: gagal menyusun pengingat: ${err}`);
        return "";
      }
    },
  };

  // Tracks the chat `reply` answers. Written ONLY by deliverIncoming, strictly
  // after the allowlist gate accepted the message -- writing it before the gate
  // let a non-allowlisted stranger become the target of the AI's next reply.
  const lastChatByBot = new Map<string, string>();

  // Indikator dinyalakan hanya untuk pesan yang LOLOS gerbang -- pesan yang
  // ditolak tidak boleh membuat bot tampak sedang menyiapkan jawaban.
  //
  // `pushToAi: false` (lapisan slash Telegram) juga mematikan indikatornya:
  // tidak ada giliran AI yang sedang disiapkan, jadi "sedang mengetik" akan
  // menjanjikan balasan yang tidak akan pernah datang.
  const deliver = async (msg: NormalizedMessage, opts: IncomingOptions = {}) => {
    const accepted = await deliverIncoming(msg, deps, lastChatByBot, opts);
    if (accepted && opts.pushToAi !== false) typing.start(msg.chatId);
    return accepted;
  };

  // One album buffer, keyed by Telegram's media_group_id. onFlush fires
  // once the debounce window closes (all photos of the album have arrived) or
  // the hard cap trips, and is the only place that finally builds one grouped
  // NormalizedMessage out of however many photo URLs were collected.
  const albumBuffer = new AlbumBuffer<{ ctx: Filter<Context, "message:photo">; url: string }>(
    1500,
    8000,
    async (mediaGroupId, items) => {
      // onFlush runs off a timer, detached from any grammy middleware chain, so a
      // rejection here would surface as a bare unhandled-rejection log with no
      // clue which bot or album it came from.
      try {
        await deliver(
          buildAlbumMessage(
            botName,
            items.map(({ ctx, url }) => ({
              messageId: ctx.message.message_id,
              chatId: ctx.chat.id,
              userId: ctx.from?.id ?? ctx.chat.id,
              userName: ctx.from?.username,
              dateSeconds: ctx.message.date,
              url,
              caption: ctx.message.caption,
            }))
          )
        );
      } catch (err) {
        console.error(`cc-plugin: album flush failed for ${botName}/${mediaGroupId}: ${err}`);
      }
    },
    10
  );

  /**
   * Pencatat untuk pesan yang lahir di LAPISAN INI, bukan dari AI: ack slash,
   * pesan error, prompt konfirmasi, jawaban `/context`.
   *
   * Bentuknya sengaja sebuah fungsi yang menghasilkan fungsi supaya `chatId`
   * dikunci di tempat pesannya dikirim. `sessionId` diambil saat mencatat, bukan
   * saat dibuat -- sesi bisa berganti di antara keduanya.
   */
  const storeCtxReply =
    (chatId: string) =>
    (messageId: string, text: string): void => {
      storeOutgoing(conversationsDb, {
        bot: botName,
        chatId,
        messageId,
        text,
        sessionId: sink.sessionId(),
      });
    };

  bot.on("message:text", async (ctx) => {
    const quote = extractQuote(ctx.message);

    // classify() lebih dulu, dan sengaja BUKAN handleSlash(): ia murni, tidak
    // menulis apa pun, jadi memanggilnya di sini tidak mengonsumsi pesannya.
    // Yang dibutuhkan cuma satu jawaban -- apakah pesan ini urusan wrapper --
    // supaya `deliver` tahu bahwa isinya tidak boleh didorong ke AI.
    const isSlash = classify(ctx.message.text).kind !== "not-slash";

    const accepted = await deliver(
      normalizeMessage(
        botName,
        {
          chatId: ctx.chat.id,
          userId: ctx.from?.id ?? ctx.chat.id,
          userName: ctx.from?.username,
          dateSeconds: ctx.message.date,
          messageId: ctx.message.message_id,
        },
        {
          text: ctx.message.text,
          replyTo: quote.replyToMessageId,
          quoteText: quote.text,
          quoteIsManual: quote.isManual,
        }
      ),
      { pushToAi: !isSlash }
    );

    // Slash Telegram dicegat SESUDAH pesannya tercatat, tidak sebelum: sistem
    // lama melakukan sebaliknya dan membuat sepuluh command tidak pernah muncul
    // di database sama sekali (spec §2.3).
    if (!accepted || !isSlash) return;

    const outcome = handleSlash(ctx.message.text, {
      botHome,
      newId: () => randomUUID(),
    });
    if (outcome.kind === "passthrough") return;
    const store = storeCtxReply(String(ctx.chat.id));
    if (outcome.kind === "error") {
      await replyStored(ctx, store, outcome.message);
      return;
    }
    if (outcome.kind === "sent") {
      await replyStored(ctx, store, outcome.ack);
      return;
    }
    if (outcome.kind === "local") {
      await replyLocalContext(ctx, botHome, store);
      return;
    }
    await replyStored(ctx, store, outcome.prompt, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Kirim", callback_data: `${SLASH_CALLBACK_GO}${outcome.command}` },
            { text: "❌ Batal", callback_data: SLASH_CALLBACK_CANCEL },
          ],
        ],
      },
    });
  });

  bot.on("message:photo", async (ctx) => {
    // ctx.getFile() already resolves to the largest photo size in ctx.message.photo
    // (grammy picks photo[photo.length - 1] internally) -- no manual selection needed.
    const file = await ctx.getFile();
    if (!file.file_path) return;
    const url = fileUrl(config.token, file.file_path);

    const mediaGroupId = ctx.message.media_group_id;
    if (mediaGroupId) {
      albumBuffer.add(mediaGroupId, { ctx, url });
      return;
    }

    const quote = extractQuote(ctx.message);
    await deliver(
      normalizeMessage(
        botName,
        {
          chatId: ctx.chat.id,
          userId: ctx.from?.id ?? ctx.chat.id,
          userName: ctx.from?.username,
          dateSeconds: ctx.message.date,
          messageId: ctx.message.message_id,
        },
        {
          text: ctx.message.caption,
          photoUrls: [url],
          replyTo: quote.replyToMessageId,
          quoteText: quote.text,
          quoteIsManual: quote.isManual,
        }
      )
    );
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    // safeName here, at the very first point a sender-chosen name enters the
    // system. Everything downstream (the inbox path, meta, the AI) sees only
    // the sanitized form.
    const fileName = safeName(doc.file_name ?? "document");
    const quote = extractQuote(ctx.message);
    const ids = {
      chatId: ctx.chat.id,
      userId: ctx.from?.id ?? ctx.chat.id,
      userName: ctx.from?.username,
      dateSeconds: ctx.message.date,
      messageId: ctx.message.message_id,
    };
    const common = {
      text: ctx.message.caption,
      replyTo: quote.replyToMessageId,
      quoteText: quote.text,
      quoteIsManual: quote.isManual,
    };

    // file_size is optional in the Telegram API. When it is absent we attempt
    // the download anyway: Telegram itself refuses anything over the limit, so
    // the worst case is a failed fetch that Task 4's tolerance already absorbs.
    if (doc.file_size !== undefined && doc.file_size > MAX_DOCUMENT_BYTES) {
      await deliver(
        normalizeMessage(botName, ids, {
          ...common,
          oversizedDocument: { fileName, sizeBytes: doc.file_size },
        })
      );
      return;
    }

    const file = await ctx.getFile();
    if (!file.file_path) return;

    await deliver(
      normalizeMessage(botName, ids, {
        ...common,
        documents: [
          { url: fileUrl(config.token, file.file_path), fileName, sizeBytes: doc.file_size },
        ],
      })
    );
  });

  bot.on("callback_query:data", async (ctx) => {
    // MUST be first and unconditional -- otherwise the button spins forever on
    // the user's Telegram client. See spec §10's own recorded lesson from the
    // old rewrite (457 green unit tests, this exact call missing in production).
    //
    // But it must not be *fatal* either: Telegram rejects acks for queries that
    // are too old (common right after a restart), and letting that throw meant
    // the human saw a stuck spinner AND the AI never learned the button was
    // pressed. Log and carry on -- storing/pushing the press matters more.
    try {
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error(`cc-plugin: answerCallbackQuery failed for ${botName} (continuing): ${err}`);
    }

    // Tap tombol konfirmasi slash adalah kendali lapisan ini, bukan pesan untuk
    // AI -- tapi ia tetap DICATAT lebih dulu, aturan yang sama dengan pesan
    // slash itu sendiri (spec §2.3). `null` berarti tombol milik fitur lain,
    // dan itu berjalan persis seperti sebelumnya.
    const slashTap = parseSlashCallback(ctx.callbackQuery.data);

    const accepted = await deliver(
      normalizeMessage(
        botName,
        {
          chatId: ctx.callbackQuery.message?.chat.id ?? ctx.from.id,
          userId: ctx.from.id,
          userName: ctx.from.username,
        },
        { callbackData: ctx.callbackQuery.data }
      ),
      { pushToAi: slashTap === null }
    );

    if (accepted && slashTap !== null) {
      const store = storeCtxReply(String(ctx.callbackQuery.message?.chat.id ?? ctx.from.id));
      if (slashTap.kind === "go") {
        const outcome = handleConfirm(slashTap.command, {
          botHome,
          newId: () => randomUUID(),
        });
        if (outcome.kind === "sent") await replyStored(ctx, store, outcome.ack);
      } else {
        await replyStored(ctx, store, "❌ Dibatalkan.");
      }
    }

    // Only now, with the press safely stored and pushed, tidy the keyboard away
    // so the same prompt cannot be answered a second time. Last on purpose:
    // Telegram refuses edits for plenty of ordinary reasons (message too old,
    // already edited, deleted by the user) and can be slow to say so, and none
    // of that is worth delaying -- or losing -- the press the AI is waiting for.
    const edit = buildTappedMessageEdit(ctx.callbackQuery.message, ctx.callbackQuery.data);
    if (edit) {
      try {
        await ctx.editMessageText(
          edit.text,
          edit.entities ? { entities: edit.entities } : undefined
        );
      } catch (err) {
        console.error(`cc-plugin: keyboard edit failed for ${botName} (press already delivered): ${err}`);
      }
    }
  });

  // Safety net, registered AFTER the `:data` handler above (which terminates the
  // middleware chain, so this never double-answers it): acknowledge any callback
  // query that carries no `data` field, which nothing this stage sends but which
  // would otherwise spin forever on the user's client.
  bot.on("callback_query", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
  });

  // Menu "/" di aplikasi Telegram. Didaftarkan sekali saat boot; server
  // Telegram yang menyimpannya, jadi ini tidak perlu diulang per pesan.
  //
  // Sengaja TIDAK di-await dan tidak fatal: ia kosmetik. Bot yang menolak
  // melayani pesan karena gagal memperbarui daftar menu menukar sesuatu yang
  // penting dengan sesuatu yang tidak.
  bot.api
    .setMyCommands(buildCommandMenu())
    .catch((err) =>
      console.error(`cc-plugin: setMyCommands failed for ${botName} (continuing): ${err}`)
    );

  startPolling(bot, {
    name: botName,
    start: () => bot.start(),
    onGiveUp: (err) => {
      console.error(`cc-plugin: poller for ${botName} gave up permanently: ${err}`);
    },
  });

  const engine: Engine = {
    bot: botName,

      async reply(
        text: string,
        buttons?: ButtonRow[],
        replyTo?: string,
        files?: string[]
      ): Promise<ReplyResult> {
        let chatId = lastChatByBot.get(botName);
        if (!chatId) {
          // W-27: Map ini hidup di memori proses -- restart mengosongkannya,
          // tapi conversations.db milik bot ini sendiri masih ingat chat
          // TERAKHIR yang benar-benar pernah membalas. Baca dari sana dulu
          // sebelum menyerah, supaya restart tidak mematikan seluruh kelas
          // notifikasi proaktif (termasuk notifikasi terjadwal) hanya karena
          // Map di memori kosong padahal buktinya ada di disk.
          const fromDb = getLastChatId(conversationsDb);
          if (fromDb) {
            chatId = fromDb;
            // Ditulis balik ke Map supaya baca database ini hanya terjadi
            // SEKALI per proses, bukan di setiap panggilan reply berikutnya.
            lastChatByBot.set(botName, chatId);
          }
        }
        if (!chatId) {
          throw new Error(
            "no_known_chat: this bot has never received a message from anyone -- not in this " +
              "process, and not in its conversation history either -- so there is nobody to " +
              "reply to. Ask the user to send this bot a message first."
          );
        }
        // Dimatikan di AWAL, bukan di akhir: pengiriman berpotongan bisa makan
        // beberapa detik, dan selama itu pesan-pesannya sudah mendarat satu per
        // satu. "typing..." yang menggantung di antara potongan tidak menambah
        // apa pun.
        typing.stop(chatId);

        // AB-4 opsi B: ditempel DI SINI, di jalur yang sama dipakai
        // `prepareReply` -- supaya AI tidak bisa menghilangkannya (ditegakkan
        // kode, bukan kesopanan) dan supaya chunking (planParts di bawah)
        // menghitung penandanya sebagai bagian dari teks yang dipotong,
        // bukan tempelan sesudahnya yang bisa merusak batas potongan.
        const marker = buildAgentOriginMarker(lastPushOrigin);
        const outgoingText = marker ? `${marker}\n\n${text}` : text;

        // Satu panggilan, di atas segalanya: pagar narasi tombol, larangan
        // buttons+files, validasi berkas, dan pemotongan teks. Kalau ada yang
        // salah, tidak ada satu pun pesan yang terlanjur berangkat -- itulah
        // kenapa keempatnya duduk di dalam SATU fungsi, bukan berjejer di sini.
        const { parts, planned } = prepareReply(outgoingText, buttons, files, (p) =>
          statSync(p).size
        );

        const replyMarkup = buttons ? buildInlineKeyboard(buttons) : undefined;

        let sentCount = 0;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]!;
          const options = planSendOptionsFor(i, parts.length, replyMarkup, replyTo);

          let sent;
          try {
            sent = await bot.api.sendMessage(chatId, part.wire, {
              ...(options ?? {}),
              // Absent, not false: a part that blew up under escaping is sent as
              // plain text, and passing parse_mode would resurrect the 400 this
              // fallback exists to avoid.
              ...(part.mv2 ? { parse_mode: "MarkdownV2" as const } : {}),
            });
          } catch (err) {
            // The parts already delivered CANNOT be recalled, so the error has to
            // carry that number. Without it the next move is to resend the whole
            // reply, and the user receives the first parts twice.
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(
              `reply failed after ${sentCount} of ${parts.length} parts sent: ${reason}`
            );
          }
          sentCount++;

          // Never fatal. The message is already on the user's phone; throwing here
          // would make the AI believe the send failed and send the whole thing
          // again.
          try {
            storeOutgoing(conversationsDb, {
              bot: botName,
              chatId,
              messageId: String(sent.message_id),
              // The raw CommonMark of THIS part -- history must read back as what
              // the AI wrote, never as the escaped wire form.
              text: part.raw,
              sessionId: sink.sessionId(),
              // Only the first part carries the quote, so only its row records one.
              replyTo: i === 0 ? replyTo : undefined,
            });
          } catch (err) {
            console.error(`cc-plugin: reply part ${i + 1} sent but not stored: ${err}`);
          }
        }

        const filesSent = await sendAttachments(
          bot.api as unknown as AttachmentApi,
          chatId,
          planned,
          (p) => new InputFile(p),
          (a, messageId) => {
            // Sama seperti baris teks: gagal menyimpan TIDAK fatal. Berkasnya
            // sudah ada di HP user, dan melempar di sini akan membuat AI
            // mengira pengirimannya gagal lalu mengulanginya.
            try {
              storeOutgoing(conversationsDb, {
                bot: botName,
                chatId,
                messageId,
                attachments: [a.path],
                kind: a.kind,
                sessionId: sink.sessionId(),
              });
            } catch (err) {
              console.error(`cc-plugin: attachment sent but not stored: ${err}`);
            }
          }
        );

        // `text.length`, BUKAN `outgoingText.length`: chars di sini menjawab
        // "berapa panjang yang AI TULIS", persis seperti sebelum AB-4 -- baris
        // penanda ditambahkan KODE, bukan AI, dan menghitungnya ke skor
        // "kepanjangan" AI hanya akan membuat AI mengira dirinya harus
        // memangkas teksnya sendiri untuk sesuatu yang bukan salahnya.
        return { chars: text.length, parts: parts.length, files: filesSent };
      },

      async history(opts): Promise<HistoryMessage[]> {
        const res = handleHistoryRequest(opts, conversationsDb);
        // Thrown, not returned as {ok:false}: the caller awaits a value now
        // instead of reading one line off a socket, and "the query was refused"
        // must not arrive looking like "nothing matched".
        if (!res.ok) throw new Error(res.error);
        return res.messages;
      },

      async search(opts): Promise<HistoryMessage[]> {
        const res = handleSearchRequest(opts, conversationsDb);
        if (!res.ok) throw new Error(res.error);
        return res.messages;
      },

      agentSend(to, text, opts): SendResult {
        return sendToPeer(
          botHome,
          to,
          {
            text,
            ...(opts.expectsReply !== undefined ? { expects_reply: opts.expectsReply } : {}),
            ...(opts.inReplyTo !== undefined ? { in_reply_to: opts.inReplyTo } : {}),
            ...(opts.hopCount !== undefined ? { hop_count: opts.hopCount } : {}),
          },
          () => new Date(),
          () => randomUUID()
        );
      },

      agentPeers(): string[] {
        return listPeers(botHome);
      },

      /**
       * Semuanya dibaca dari BERKAS tetangga, tidak satu pun proses disapa.
       *
       * Itu bukan kebetulan: menjalankan apa pun terhadap folder bot yang hidup
       * pernah MEREBUT token Telegram-nya (`lock.ts` memang dirancang membunuh
       * pemegang lock lama, dan itu terjadi sungguhan 2026-08-05). Membaca
       * berkas tidak punya efek samping apa pun terhadap bot yang sedang
       * bekerja, dan itulah satu-satunya cara yang aman untuk bertanya.
       *
       * `process.kill(pid, 0)` tidak mengirim sinyal apa pun -- ia hanya
       * bertanya apakah PID itu ada, dan itu pengecualian yang disengaja.
       */
      agentStatuses(): PeerStatus[] {
        const parent = dirname(botHome);
        return listPeers(botHome).map((name) => {
          const home = join(parent, name);
          let pidText: string | null = null;
          try {
            pidText = readFileSync(botPidPathIn(home), "utf8");
          } catch {
            // Belum pernah dijalankan, atau berkasnya dihapus. Bukan kesalahan
            // yang perlu dilaporkan -- jawabannya cuma "tidak hidup".
          }
          const pid = pidFrom(pidText);
          let alive = false;
          if (pid !== null) {
            try {
              process.kill(pid, 0);
              alive = true;
            } catch {
              alive = false;
            }
          }
          return summarizePeer(name, readCapturedStatus(statusPathIn(home)), alive);
        });
      },

      onPush(fn: (msg: PushMessage) => void): void {
        handler = fn;
        while (buffered.length > 0) fn(buffered.shift()!);
      },

    close(): void {
      typing.stopAll();
      stopSessionAnnouncer();
      // Sebelum db ditutup: pemindai yang masih berjalan akan mendorong ke
      // sink yang tujuannya sudah pergi.
      stopInboxScanner();
      releaseBotLock(botPidPathIn(botHome), process.pid);
      conversationsDb.close();
    },
  };

  /**
   * Nama sesi yang benar-benar milik sesi INI, atau `null`.
   *
   * Dibaca dari transcript Claude Code, BUKAN dari `session_name` di
   * `status.json`. Alasannya lengkap di `context/session-title.ts`; ringkasnya:
   * `status.json` cuma ditulis saat statusline digambar ulang, dan `/rename`
   * tidak menggambar ulang apa pun -- terukur 59 menit telat pada
   * `mirza_02_bot` 2026-08-07.
   *
   * `status.json` masih dipakai untuk satu hal saja: memberi tahu DI MANA
   * transcript CC disimpan. Isinya boleh basi; direktorinya tidak.
   *
   * Perbandingan `session_id` yang dulu ada di sini ikut hilang, dan itu bukan
   * kelalaian: identitas sesi sekarang dijamin nama berkas `<session.id>.jsonl`
   * yang dibuka, bukan oleh dua field yang dicocokkan.
   */
  const currentSessionName = (): string | null => {
    const captured = readCapturedStatus(statusPathIn(botHome));
    const sid = readCurrentSessionId(botHome);
    if (!captured || sid === undefined) return null;
    return readSessionNameFromTranscript(captured.payload?.transcript_path, sid);
  };

  const announce = async (notice: SessionNotice): Promise<void> => {
    try {
      await engine.reply(renderSessionNotice(notice, botName));
    } catch (err) {
      // Bot yang belum pernah disapa siapa pun memang tidak punya tujuan
      // (no_known_chat). Itu keadaan sah, bukan kerusakan -- dan pengumuman
      // yang gagal tidak boleh menjatuhkan apa pun.
      console.error(`cc-plugin: pengumuman sesi tidak terkirim: ${err}`);
    }
  };

  // --- Pengumuman START -------------------------------------------------
  //
  // Menunggu tangkapan statusline milik sesi ini lebih dulu, karena di detik
  // engine lahir statuslinenya biasanya belum sempat digambar. Kalau sesudah
  // ditunggu ia tetap tidak datang, yang dikirim mengatakan "belum terbaca" --
  // BUKAN nama dari tangkapan lama.
  void (async () => {
    const name = await waitForCapture(currentSessionName, {
      attempts: 20,
      delayMs: 500,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    if (name !== null) rememberNotifiedSessionName(conversationsDb, name);
    await announce({ kind: "start", name });
  })();

  // --- Pengumuman NAMA BERUBAH ------------------------------------------
  //
  // Polling, bukan fs.watch: `status.json` ditulis dengan rename atomik, dan
  // watcher pada berkas yang di-rename kehilangan targetnya diam-diam di
  // Windows. Pemindai inbox memakai pola yang sama dengan alasan sejenis.
  const announcerTimer = setInterval(() => {
    try {
      const name = currentSessionName();
      if (!shouldNotifyRename(name, getNotifiedSessionName(conversationsDb))) return;
      rememberNotifiedSessionName(conversationsDb, name!);
      void announce({ kind: "renamed", name: name! });
    } catch (err) {
      console.error(`cc-plugin: pemantau nama sesi gagal: ${err}`);
    }
  }, 5000);
  announcerTimer.unref?.();
  const stopSessionAnnouncer = (): void => clearInterval(announcerTimer);

  return { ok: true, engine };
}

/**
 * Menjawab /context dari data lokal. TIDAK pernah menghubungi Claude Code.
 *
 * installBridge DIPANGGIL LAGI di sini, bukan cuma di startEngine. Ini bukan
 * mubazir: dua alasan.
 *
 * Pertama, idempoten -- kalau startEngine sudah menyembuhkannya (atau bridge
 * memang sudah benar), jawabannya "already-installed" dan tidak menulis apa
 * pun; panggilan kedua ini praktis gratis.
 *
 * Kedua, dan ini yang penting: kalau pemasangannya ditolak atau di-rollback,
 * /context adalah SATU-SATUNYA momen user berhak tahu ALASANNYA -- dan itu
 * harus dilaporkan ke Telegram, bukan cuma ke stderr proses (yang tidak
 * pernah dibaca user). startEngine sendiri hanya mencatat ke stderr karena
 * kegagalan bridge tidak boleh menggagalkan start; jalur ini yang menutup
 * lubang itu dengan melapor ke tempat yang user benar-benar lihat.
 *
 * Alurnya meniru sistem lama, dan alasannya terukur hidup 2026-08-04: pada
 * pemasangan pertama, berkas tangkapan BELUM ADA -- Claude Code belum sempat
 * menggambar baris status sekali pun. Menjawab "belum ada data" di detik itu
 * benar secara harfiah tapi menyesatkan: yang perlu user lakukan hanya
 * menunggu. Bedanya dengan sistem lama, yang ditunggu di sini adalah
 * KEJADIANNYA (berkasnya muncul), bukan durasi yang ditebak.
 *
 * Kalau pemasangannya ditolak atau di-rollback, yang dilaporkan ALASANNYA, apa
 * adanya. Itu inti syarat spec §1: statusline user menang, dan /context harus
 * mengatakan kenapa ia mengalah, bukan diam-diam gagal.
 */
async function replyLocalContext(
  ctx: ReplyableCtx,
  botHome: string,
  /**
   * Pencatatnya dilewatkan, tidak diambil sendiri: fungsi ini di luar
   * `startEngine` dan tidak punya db maupun identitas bot. Sebelum 2026-08-07 ia
   * memang tidak mencatat apa pun -- SETIAP jawaban /context yang pernah dikirim
   * hilang dari riwayat percakapan botnya sendiri.
   */
  store: (messageId: string, text: string) => void
): Promise<void> {
  const install = installBridge({
    // Folder bot ADALAH project dir-nya. Dulu keduanya dilewatkan terpisah
    // (botName untuk berkas tangkapan, home untuk settings), dan dua sumber
    // untuk satu fakta selalu bisa berbeda pendapat.
    projectDir: botHome,
    userSettingsPath: join(homedir(), ".claude", "settings.json"),
    bridgeCommand: buildBridgeCommand(
      pluginRootFrom(process.env.CLAUDE_PLUGIN_ROOT, import.meta.url)
    ),
    chainPath: chainedStatuslinePathIn(botHome),
  });

  if (install.kind === "refused" || install.kind === "rolled-back") {
    await replyStored(
      ctx,
      store,
      `Jembatan statusline TIDAK dipasang, dan itu disengaja.

` +
        `Alasan: ${install.reason}

` +
        `Statusline Claude Code milikmu dibiarkan apa adanya. Kalau harus memilih, ` +
        `/context yang mengalah -- bukan sebaliknya.`
    );
    return;
  }

  const path = statusPathIn(botHome);
  const ready = readCapturedStatus(path);
  if (ready !== null) {
    await replyStored(ctx, store, renderContext(ready, Date.now()));
    return;
  }

  // Sampai di sini berarti bridge-nya baru saja dipasang dan CC belum sempat
  // menggambar baris status. Beri tahu dulu, baru tunggu -- diam belasan detik
  // tidak bisa dibedakan user dari bot yang mati.
  await replyStored(
    ctx,
    store,
    install.kind === "installed"
      ? `⏳ Jembatan statusline baru dipasang. Menunggu Claude Code menggambar baris status...`
      : `⏳ Menunggu data statusline...`
  );

  const got = await waitForCapture(() => readCapturedStatus(path), {
    attempts: 12,
    delayMs: 1500,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  if (got === null) {
    await replyStored(
      ctx,
      store,
      `Masih belum ada data statusline sesudah menunggu.

` +
        `Jembatannya terpasang, tapi Claude Code belum menggambar baris status. ` +
        `Pakai CC sebentar, lalu kirim /context lagi.`
    );
    return;
  }

  // sessionName sengaja tidak dilewatkan: payload statusline sudah memuat
  // session_name-nya sendiri, ditulis Claude Code. Sumber kedua hanya akan
  // menambah kemungkinan keduanya berbeda.
  await replyStored(ctx, store, renderContext(got, Date.now()));
}
