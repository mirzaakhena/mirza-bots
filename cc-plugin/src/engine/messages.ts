import { Bot, InlineKeyboard } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { Database } from "bun:sqlite";
import { getMessagesAround, searchMessages } from "./db/conversations-schema";
import {
  handleIncomingMessage,
  type IncomingOptions,
  type NormalizedMessage,
  type PollerDeps,
} from "./telegram/poller";
import { SLASH_CALLBACK_NAMESPACE } from "./slash";
import type { Button, ButtonRow, MessagesResult } from "./types";

export function apiRoot(): string {
  return process.env.TELEGRAM_API_ROOT ?? "https://api.telegram.org";
}

export function makeBot(token: string): Bot {
  const root = process.env.TELEGRAM_API_ROOT;
  return root ? new Bot(token, { client: { apiRoot: root } }) : new Bot(token);
}

// grammy's ctx.getFile() only hands back a `file_path`; it has no download-URL
// builder, so build the URL by hand against the same apiRoot makeBot uses --
// that way tests route file downloads to the fake server too.
export function fileUrl(token: string, filePath: string): string {
  return `${apiRoot()}/file/bot${token}/${filePath}`;
}

/**
 * Builds a NormalizedMessage out of the identity fields every Telegram handler
 * has in common, plus whatever payload that particular handler carries.
 *
 * Exported for tests. This existing as one function is what keeps the four
 * handlers below from each re-deriving the same five fields -- the duplication
 * that let the reply-hijack bug (lastChatByBot written before the allowlist gate)
 * exist in four separate copies.
 */
export function normalizeMessage(
  botName: string,
  ids: {
    chatId: string | number;
    userId: string | number;
    userName?: string;
    dateSeconds?: number;
    messageId?: string | number;
  },
  payload: Pick<
    NormalizedMessage,
    | "text"
    | "photoUrls"
    | "callbackData"
    | "replyTo"
    | "quoteText"
    | "quoteIsManual"
    | "documents"
    | "oversizedDocument"
  >
): NormalizedMessage {
  return {
    bot: botName,
    chatId: String(ids.chatId),
    userId: String(ids.userId),
    userName: ids.userName,
    messageId: ids.messageId !== undefined ? String(ids.messageId) : undefined,
    ts: new Date((ids.dateSeconds ?? Date.now() / 1000) * 1000).toISOString(),
    ...payload,
  };
}

/**
 * Riwayat sekarang selalu milik bot pemanggilnya, tanpa perlu diperiksa.
 *
 * Dulu di sini ada `resolveOwnBot`, yang memastikan bot pemanggil terdaftar di
 * `config.bots`, dan sebelumnya lagi ada parameter `bot` untuk "mengintip"
 * percakapan tetangga (K-3). Keduanya berdiri di atas satu database bersama.
 * Sesudah state per-folder, `db` yang dilewatkan ADALAH berkas milik bot ini —
 * "bot lain" tidak punya tempat di dalamnya, jadi tidak ada yang perlu
 * ditolak, dan penolakan yang tidak menolak apa pun cuma jalur mati.
 *
 * Diukur sebelum parameter `bot` dibuang (2026-08-04): seluruh riwayat sistem
 * baru memuat 136 baris milik satu bot dan 1 baris nyasar dari percobaan awal —
 * lintas-bot belum pernah benar-benar terjadi.
 */
export function handleHistoryRequest(
  req: { messageId: string; before?: number; after?: number },
  db: Database
): MessagesResult {
  return {
    ok: true,
    messages: getMessagesAround(db, {
      messageId: req.messageId,
      before: req.before ?? 0,
      // Defaults to looking forward: the motivating request is "trace a few
      // messages AFTER the one I quoted" (spec §9.2).
      after: req.after ?? 10,
    }),
  };
}

export function handleSearchRequest(
  req: { query: string; limit?: number },
  db: Database
): MessagesResult {
  try {
    return { ok: true, messages: searchMessages(db, req.query, { limit: req.limit ?? 20 }) };
  } catch (err) {
    // FTS5 rejects plenty of ordinary-looking input (an unbalanced quote, a
    // trailing AND). The AI writes these queries, so name the problem in a way
    // that tells it to rephrase rather than leaving it a generic handler crash.
    return { ok: false, error: `bad_search_query: ${err}` };
  }
}

export type AlbumItem = {
  messageId: number;
  chatId: string | number;
  userId: string | number;
  userName?: string;
  dateSeconds?: number;
  url: string;
  caption?: string;
};

/**
 * Turns however many photos the buffer collected into ONE NormalizedMessage.
 *
 * Pure and exported so the ordering and caption rules are testable without
 * standing up grammy, a bot, or main() -- the flush callback itself only adapts
 * grammy contexts into AlbumItems and calls this.
 *
 * Caption rules (spec §5.4 item 4), driven by how many members carry a caption:
 *   0  -> no text at all
 *   1  -> that caption verbatim, unlabelled (the ordinary case: the user is just
 *         talking about the album)
 *   2+ -> each labelled `Photo <n>:` by its position in the SORTED album, so the
 *         AI can tell which caption belongs to which file
 * Before this, only the first member's caption survived and the rest were lost.
 */
export function buildAlbumMessage(botName: string, items: AlbumItem[]): NormalizedMessage {
  // SCAR-055a: the buffer preserves arrival order, and photos arrive out of order
  // under load. Every downstream label is only correct once this sort has run.
  const ordered = [...items].sort((a, b) => a.messageId - b.messageId);
  const first = ordered[0]!;

  const captioned = ordered
    .map((item, i) => ({ position: i + 1, caption: item.caption }))
    .filter((c): c is { position: number; caption: string } => c.caption !== undefined);

  let text: string | undefined;
  if (captioned.length === 1) text = captioned[0]!.caption;
  else if (captioned.length > 1)
    text = captioned.map((c) => `Photo ${c.position}: ${c.caption}`).join("\n");

  return {
    ...normalizeMessage(
      botName,
      {
        chatId: first.chatId,
        userId: first.userId,
        userName: first.userName,
        dateSeconds: first.dateSeconds,
        messageId: first.messageId,
      },
      { text, photoUrls: ordered.map((i) => i.url) }
    ),
    isAlbum: true,
    messageIds: ordered.map((i) => String(i.messageId)),
  };
}

/**
 * Decides how a message should read once one of its buttons has been tapped.
 *
 * Pure and exported for the same reason buildAlbumMessage is: these rules are
 * worth testing without standing up grammy or a bot. `null` means "leave the
 * message alone" -- there is nothing an editMessageText could do with a message
 * that has no text (a caption-only one, or one Telegram reports as inaccessible).
 *
 * What removes the keyboard is what this payload does NOT carry: Telegram drops
 * the markup of any message edited without a reply_markup. Left untouched, the
 * same prompt stays tappable forever and gets answered twice.
 *
 * The original entities are carried over because the edit text is sent as plain
 * text -- an edit without them silently strips every bold/italic/code run the
 * message had. Appending at the END is what keeps those offsets valid.
 */
export function buildTappedMessageEdit(
  message: { text?: string; entities?: MessageEntity[] } | undefined,
  callbackData: string
): { text: string; entities?: MessageEntity[] } | null {
  if (typeof message?.text !== "string") return null;

  // The callback DATA, not the button's label: Telegram does not send the label
  // back with the query, and fleetd never stored the keyboard it forwarded on the
  // AI's behalf. The data is the only truthful thing we have to show here.
  const edit: { text: string; entities?: MessageEntity[] } = {
    text: `${message.text}\n\n→ ${callbackData}`,
  };
  if (message.entities?.length) edit.entities = message.entities;
  return edit;
}

/**
 * Returns whether this message was accepted, not just a side effect.
 *
 * The caller must distinguish "accepted" from "rejected by allowlist" to decide
 * whether to enable the typing indicator. `lastChatByBot` cannot answer this:
 * the map retains the previous chat when a message is rejected, so checking it
 * would cause a message from a stranger to trigger the indicator for a
 * legitimate user's session.
 *
 * The ONLY place `lastChatByBot` is ever written, and it happens strictly after
 * handleIncomingMessage's allowlist gate has accepted the message. Writing it
 * before the gate (the old behaviour, duplicated across all four handlers)
 * meant any stranger who messaged the bot became the target of the AI's next
 * `reply` -- an information-disclosure bug, since their own message was
 * dropped but the AI's answer would have gone to them.
 *
 * Exported for tests.
 */
export async function deliverIncoming(
  msg: NormalizedMessage,
  deps: PollerDeps,
  lastChatByBot: Map<string, string>,
  opts: IncomingOptions = {}
): Promise<boolean> {
  const accepted = await handleIncomingMessage(msg, deps, opts);
  if (accepted) lastChatByBot.set(msg.bot, msg.chatId);
  return accepted;
}

/**
 * U-5: guards the one button convention a phone screen cannot forgive.
 *
 * Button labels have to stay short, so the convention is bare numbers on the
 * buttons and a numbered list in the body saying what each number means. The AI
 * kept shipping the buttons and forgetting the list, leaving the human holding a
 * keyboard of `1` / `2` with nothing to read them against -- three times, and
 * once with an in-band apology for having done it twice. The rule lived only as
 * text asking the AI to remember, and text that asks nicely leaks; anything a
 * machine can guarantee, a machine guarantees.
 *
 * Pure and exported for the same reason buildAlbumMessage and
 * buildTappedMessageEdit are: the rule is worth testing without standing up
 * grammy. `null` means "send it".
 *
 * Deliberately fires only where the intent is unambiguous:
 *   - non-numeric labels are ignored entirely, so the convention's own required
 *     escape hatch (`✏️ Explain manually`) can never trip it, and a descriptive
 *     keyboard (`✅ Ya` / `❌ Tidak`) is none of this rule's business -- that
 *     direction belongs to `findWordyButtonLabels` below, which is the pair of
 *     this one: this guard makes numbers meaningful, that one makes them
 *     mandatory;
 *   - 2+ numeric labels are required, because a lone `1` is as likely to be a
 *     quantity as an option, and blocking a send on that guess costs more than
 *     it saves.
 */
export function findMissingButtonNarration(text: string, buttons?: ButtonRow[]): string | null {
  // Rows are cosmetic -- the human sees one keyboard however it is wrapped.
  const numeric = (buttons ?? []).flat().map((b) => b.text.trim()).filter((t) => /^\d+$/.test(t));
  if (numeric.length < 2) return null;

  const missing = [...new Set(numeric)].filter(
    // Anchored to the start of a line because that is what a legend looks like;
    // the same digit inside a sentence ("option 2 is safer") leaves the button
    // just as unreadable. [^\S\r\n] is "whitespace that is not a line break", so
    // a list nested under a heading still counts.
    (n) => !new RegExp(`^[^\\S\\r\\n]*${n}[.)]`, "m").test(text)
  );
  if (missing.length === 0) return null;

  // Naming the fix, not just the fault: a refusal that does not teach the
  // correct alternative is a rule the AI cannot comply with, and it will simply
  // retry the same message.
  return (
    `numbered_buttons_without_list: numeric button labels need a matching numbered line in the ` +
    `message text, and ${missing.map((n) => `"${n}"`).join(", ")} ` +
    `${missing.length === 1 ? "has" : "have"} none. Either add one line per number to the text ` +
    `(e.g. "1. Lanjut backup" / "2. Batalkan"), or -- only if this is really a yes/no ` +
    `confirmation -- drop the numbers and use two short descriptive labels instead ` +
    `(e.g. "✅ Ya" / "❌ Tidak"). Nothing was sent -- fix and resend.`
  );
}

/**
 * Kosakata konfirmasi: satu-satunya keyboard yang boleh berlabel kata.
 *
 * Dipisah jadi dua daftar karena yang dicari BUKAN "labelnya pendek" melainkan
 * "keyboardnya sepasang, satu setuju satu tolak". Dua tombol pendek yang
 * sama-sama setuju ("Ya" / "Oke") bukan konfirmasi, itu menu yang kebetulan
 * kembar -- dan menu wajib berangka.
 *
 * `\b` memperlakukan emoji sebagai batas kata, jadi "✅ Ya" tetap cocok tanpa
 * satu baris pun untuk membersihkannya lebih dulu.
 */
const CONFIRM_YES = /\b(ya|iya|yes|y|ok|oke|okay|sip|siap|gas|lanjut|jalan|kirim|setuju|benar)\b/i;
const CONFIRM_NO = /\b(tidak|ga|gak|nggak|enggak|no|jangan|batal|batalkan|cancel|stop|skip|nanti)\b/i;

/** `null` kalau labelnya tidak terbaca sebagai setuju MAUPUN tolak. */
function confirmSide(label: string): "yes" | "no" | null {
  const yes = CONFIRM_YES.test(label);
  const no = CONFIRM_NO.test(label);
  // Label yang memuat keduanya ("ya, jangan") ambigu bagi mesin, dan kalau
  // ambigu bagi mesin ia juga ambigu di layar HP. Diperlakukan sebagai bukan
  // konfirmasi, bukan ditebak.
  if (yes === no) return null;
  return yes ? "yes" : "no";
}

/**
 * Pasangan `findMissingButtonNarration`, dan arahnya berlawanan: guard itu
 * menuntut daftar bernomor SEKALI label berupa angka, guard ini menuntut
 * labelnya berupa angka sejak awal.
 *
 * ## Kenapa ada (keputusan user 2026-08-14)
 *
 * Konvensinya sudah tertulis sejak spec 2026-08-11 -- "let the buttons be the
 * bare numbers" -- tapi hanya sebagai teks. Akibatnya satu arah dijaga mesin
 * dan arah sebaliknya tidak: AI yang menulis label berupa kata tidak pernah
 * ditegur siapa pun, dan itulah yang user temukan di layar. Doktrin repo ini
 * sudah menjawabnya sekali di guard sebelah: teks yang meminta baik-baik itu
 * bocor; apa yang mesin bisa jamin, mesin jamin.
 *
 * Tanda ✅ untuk opsi rekomendasi SENGAJA tidak ikut dijaga di sini. Ia hidup
 * di BADAN pesan, bukan di tombol -- keputusan user pada hari yang sama, dan
 * bukan sekadar selera: centang di tombol membuat label berhenti terbaca
 * sebagai angka murni, yang berarti `findMissingButtonNarration` mati diam
 * persis di keyboard yang paling ramai. Dan "ada rekomendasi" memang tidak bisa
 * dipaksakan mesin, karena tidak setiap menu punya satu.
 *
 * ## Ambangnya, dan pengecualian tunggalnya
 *
 * Dua label berkata baru menyala, alasan yang sama dengan ambang 2 di guard
 * sebelah: satu tombol berkata bukan menu, ia tombol tindakan ("Kirim
 * sekarang"), dan memblokirnya lebih mahal dari yang diselamatkan.
 *
 * Konfirmasi ya/tidak dua tombol dikecualikan. Bukan kompromi: "✅ Ya" /
 * "❌ Tidak" sudah menjelaskan dirinya di layar, dan menomorinya justru menambah
 * satu lapisan terjemahan pada pertanyaan yang paling tidak butuh.
 *
 * Tombol jalan keluar dibuang dari hitungan lebih dulu. Mesin menempelkannya
 * SESUDAH guard ini (lihat urutan di `prepareReply`), jadi normalnya ia tidak
 * pernah terlihat di sini -- tapi dedupe di `withManualFallback` ada justru
 * karena AI kadang menulisnya sendiri, dan keyboard yang lolos dedupe tidak
 * boleh mati di guard ini.
 */
export function findWordyButtonLabels(buttons?: ButtonRow[]): string | null {
  const labels = (buttons ?? [])
    .flat()
    .filter(
      (b) => b.data !== MANUAL_FALLBACK_BUTTON.data && b.text.trim() !== MANUAL_FALLBACK_BUTTON.text
    )
    .map((b) => b.text.trim());

  const wordy = labels.filter((t) => !/^\d+$/.test(t));
  if (wordy.length < 2) return null;

  // Diperiksa atas SELURUH label, bukan cuma yang berkata: "1" / "❌ Tidak"
  // bukan konfirmasi, itu menu setengah jadi.
  if (labels.length === 2) {
    const [a, b] = labels.map(confirmSide);
    if (a !== null && b !== null && a !== b) return null;
  }

  return (
    `wordy_button_labels: tombol menu harus berlabel ANGKA saja, sementara ` +
    `${wordy.map((t) => `"${t}"`).join(", ")} berupa kata. Tulis opsinya sebagai daftar bernomor ` +
    `di badan pesan (mis. "1. Lanjut backup" / "2. Batalkan"), taruh tanda ✅ pada BARIS yang kamu ` +
    `rekomendasikan -- bukan pada tombolnya -- lalu kirim ulang dengan tombol "1" dan "2". ` +
    `Pengecualian satu-satunya adalah konfirmasi ya/tidak dua tombol ("✅ Ya" / "❌ Tidak"). ` +
    `Tidak ada yang terkirim.`
  );
}

/**
 * Batas Telegram untuk `callback_data`: 1-64 **byte**. Di atasnya API menjawab
 * 400 `BUTTON_DATA_INVALID`.
 */
export const MAX_CALLBACK_DATA_BYTES = 64;

/**
 * Dua hal yang membuat sebuah tombol tidak boleh berangkat. `null` berarti
 * kirim.
 *
 * ## Kenapa di sini, bukan dibiarkan Telegram yang menolak
 *
 * Tombol menempel pada potongan TERAKHIR (lihat `planSendOptionsFor`), jadi
 * pada balasan yang terpotong, potongan-potongan sebelumnya SUDAH mendarat di
 * HP user ketika 400-nya datang. Yang AI terima adalah
 * `reply failed after N of M parts sent`, dan tidak ada cara menarik kembali
 * yang terlanjur terkirim. Diperiksa di `prepareReply` berarti tidak ada satu
 * byte pun yang berangkat.
 *
 * ## Kenapa BYTE, bukan panjang string
 *
 * Satu emoji memakan empat byte tapi dihitung satu code point (dan dua unit
 * UTF-16). Menghitung `data.length` akan meloloskan data yang Telegram tolak.
 * Pelajaran yang sama sudah dibayar di `confirmFits` (lapisan slash); yang
 * kurang cuma penerapannya di jalur ini -- satu-satunya jalur yang datanya
 * ditulis AI, bukan mesin.
 *
 * ## Kenapa namespace `slash:` ikut ditolak
 *
 * `parseSlashCallback` mengenali tombolnya sendiri dari PREFIKS string saja.
 * Tombol AI yang datanya kebetulan diawali `slash:` karena itu tidak pernah
 * sampai ke AI, langsung ditulis ke `slash/`, dan diketikkan cc-wrapper ke
 * Claude Code -- melewati prompt konfirmasi yang justru satu-satunya alasan
 * jalur itu ada. Namespace itu milik lapisan slash; di sini ia ditolak, bukan
 * diam-diam diambil alih.
 */
export function findUnsafeButtonData(buttons?: ButtonRow[]): string | null {
  for (const btn of (buttons ?? []).flat()) {
    const bytes = Buffer.byteLength(btn.data, "utf8");
    if (bytes > MAX_CALLBACK_DATA_BYTES) {
      return (
        `callback_data_too_long: tombol "${btn.text}" membawa data ${bytes} byte, ` +
        `sementara Telegram hanya menerima ${MAX_CALLBACK_DATA_BYTES}. Dihitung per BYTE, ` +
        `jadi satu emoji memakan empat. Pendekkan datanya -- ia cuma penanda pilihan, ` +
        `bukan tempat menaruh isi. Tidak ada yang terkirim.`
      );
    }
    if (btn.data.startsWith(SLASH_CALLBACK_NAMESPACE)) {
      return (
        `reserved_callback_data: tombol "${btn.text}" memakai awalan ` +
        `"${SLASH_CALLBACK_NAMESPACE}", yang milik lapisan slash Telegram. Tap-nya tidak akan ` +
        `pernah sampai kepadamu -- ia langsung disuntikkan ke Claude Code tanpa konfirmasi. ` +
        `Pakai awalan lain. Tidak ada yang terkirim.`
      );
    }
  }
  return null;
}

export function buildInlineKeyboard(rows: ButtonRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [i, row] of rows.entries()) {
    if (i > 0) kb.row();
    for (const btn of row) kb.text(btn.text, btn.data);
  }
  return kb;
}

/**
 * Tombol jalan keluar yang mesin tempelkan ke SETIAP keyboard yang AI kirim.
 *
 * Kenapa mesin, bukan aturan: sistem lama sudah meminta AI menempelkannya
 * sendiri lewat "self-check ritual", dan berkas aturannya sendiri mencatat
 * hasilnya -- "the single most forgotten rule in this skill". Aturan ini sudah
 * pernah gagal dalam bentuk instruksi, di sistem yang instruksinya masih hidup.
 *
 * Kenapa `data`-nya sepanjang ini, bukan `manual`: data dibaca DUA pembaca.
 * `buildTappedMessageEdit` di atas menempelkannya ke pesan yang ditap, jadi
 * user melihatnya di layar; dan tap mendaratkannya di context AI sebagai pesan
 * user. Data bisu gagal di dua-duanya -- di layar terbaca seperti kebocoran
 * internal, di context ia satu token tanpa arti begitu sesi berganti.
 *
 * Kenapa berbentuk "let me ...", bukan "explain manually": ia mendarat SEBAGAI
 * PESAN USER. "explain manually" dari mulut user terbaca sebagai perintah
 * kepada AI untuk menjelaskan -- arahnya terbalik dari maksudnya.
 *
 * 31 byte, jauh di bawah batas 64 byte `callback_data`. Yang menjaga angka itu
 * adalah test yang menjalankan `findUnsafeButtonData` atas konstanta ini, bukan
 * salinan kedua dari angka 64 di dalam test.
 */
export const MANUAL_FALLBACK_BUTTON: Button = {
  text: "✏️ Explain manually",
  data: "let me explain manually instead",
};

/**
 * Menempelkan `MANUAL_FALLBACK_BUTTON` sebagai baris TERAKHIR, dan tidak
 * melakukan apa-apa pada keyboard kosong.
 *
 * Keyboard kosong dilewati bukan demi kerapian: `assertNoButtonsWithFiles`
 * melempar bila `buttons` dan `files` sama-sama terisi, jadi injeksi tanpa
 * syarat akan membuat SETIAP balasan yang mengirim berkas gagal.
 *
 * Dedupe-nya berdasarkan `data` dan mengabaikan posisi. Label bisa berubah
 * tanpa mengubah arti tombolnya; data adalah identitasnya. Dan memeriksa
 * posisi menuntut keputusan kedua -- pindahkan atau biarkan -- sementara
 * memindahkan tombol yang AI tulis sendiri adalah mesin menyunting maksud AI.
 * Konsekuensinya diterima sadar: fallback yang AI tulis di tengah tetap di
 * tengah. Aturan `buttons-when-pickable` melarang AI menulisnya, jadi dedupe
 * ini jaring, bukan jalan utama.
 *
 * Idempoten, dan itu yang membuatnya aman dipanggil dari titik kedua kalau
 * suatu hari ada.
 */
export function withManualFallback(rows: ButtonRow[]): ButtonRow[] {
  if (rows.length === 0) return rows;
  for (const r of rows) {
    for (const b of r) {
      if (b.data === MANUAL_FALLBACK_BUTTON.data) return rows;
    }
  }
  return [...rows, [MANUAL_FALLBACK_BUTTON]];
}

