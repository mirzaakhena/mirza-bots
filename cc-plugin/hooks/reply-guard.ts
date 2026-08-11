#!/usr/bin/env bun
/**
 * Stop hook: block once when a channel-driven conversation is about to end with
 * no `reply` sent since the newest inbound message.
 *
 * Why this exists at all: the person who sent that message is reading Telegram,
 * not this transcript. If the turn ends without a `reply` tool call, they get
 * nothing -- no error, no hint, just silence they cannot distinguish from a
 * broken bot. That silence is the most expensive failure class in this project.
 *
 * Why it is urgent NOW: the terse-turn protocol trains the AI to close a turn
 * with a bare ".". That makes "answered, then closed" and "forgot to answer,
 * then closed" look identical from the outside. The protocol raised the odds of
 * exactly this failure, so it needs a machine guarding it rather than the AI
 * remembering.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// How Claude Code names this plugin's MCP server. Both the inbound detection and
// the reply-tool name are scoped by it, so the guard only ever speaks for its own
// channel -- a session may have several channel plugins connected at once.
const PLUGIN_ID = "cc-plugin";
const REPLY_TOOL = `mcp__plugin_${PLUGIN_ID}_${PLUGIN_ID}__reply`;

/**
 * Penanda turn yang dipicu bot lain. Salinan sengaja dari `src/server.ts`.
 *
 * Hook ini hanya boleh mengimpor `node:` (lihat header berkas), jadi yang
 * menutup jarak antara dua literal ini adalah sebuah TEST yang mengadu
 * keduanya, bukan sebuah import. Dua literal yang harus sama akan menyimpang
 * diam-diam kalau tidak ada yang memeriksanya (K-15).
 */
export const AGENT_TURN_MARKER = "[from: agent]";

export interface TranscriptAnalysis {
  channelDriven: boolean;
  latestInboundIdx: number;
  /**
   * Posisi pesan terakhir yang datang dari BOT LAIN.
   *
   * Ada karena mengecualikan pesan antar-bot dari `latestInboundIdx` saja
   * TIDAK CUKUP, dan itu terukur: 2026-08-07 06:54 sebuah giliran antar-bot
   * menulis prosa, `latestProseIdx` ikut bergerak, `latestInboundIdx` tidak --
   * jadi prosa milik giliran antar-bot ditimpakan ke giliran Telegram
   * sebelumnya. Guard menuduh "kamu sudah membalas lewat reply" untuk giliran
   * yang tidak memanggil `reply` sama sekali, lalu menyuruhnya DIAM.
   *
   * Penolakan bot itu akhirnya tidak sampai ke siapa pun, dan tidak ada yang
   * terlihat gagal. **Pengecualian yang dipasang di satu penanda saja adalah
   * pengecualian yang menjaga pintu sambil membuka jendela.**
   */
  latestAgentInboundIdx: number;
  /**
   * Posisi giliran yang DIKETIK langsung di terminal ini oleh orangnya.
   *
   * Pintu masuk ketiga, dan yang paling lama tidak terlihat: guard hanya
   * mengenal Telegram dan bot lain, jadi `latestInboundIdx` tidak pernah
   * bergeser saat user pindah ke terminal -- dan prosa jawaban giliran terminal
   * ditimpakan ke giliran Telegram yang sudah lama selesai.
   *
   * Terukur: transcript bot-02 `6ad8b29d` 2026-08-11 -- pesan Telegram di baris
   * 1012, `reply` di 1022, prompt terminal di 1052, prosanya di 1107. Guard
   * memvonis `no-prose` dan menyuruh giliran itu DIAM, padahal transcript satu-
   * satunya tempat jawabannya bisa mendarat. Aturan yang memakan jawaban benar
   * lebih buruk daripada aturan yang tidak ada.
   */
  latestLocalInboundIdx: number;
  latestReplyIdx: number;
  /**
   * Posisi giliran assistant terakhir yang menulis PROSA ke transcript.
   *
   * Bukan "punya text part": protokol terse-turn justru menyuruh mengakhiri
   * giliran dengan satu titik, jadi `.` adalah kepatuhan dan tidak boleh
   * dihitung sebagai pelanggaran.
   */
  latestProseIdx: number;
}

/**
 * Pulls the readable text out of a transcript entry regardless of its shape.
 *
 * Load bearing: an inbound channel message arrives with `message.content` as a
 * plain STRING, while an assistant turn carries an ARRAY of parts. The old
 * system's guard tested `Array.isArray(content)` and returned early otherwise --
 * porting that check verbatim would have made this hook see no inbound at all.
 * Installed, running, and silently guarding nothing.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

export function analyzeTranscript(lines: string[]): TranscriptAnalysis {
  let channelDriven = false;
  let latestInboundIdx = -1;
  let latestAgentInboundIdx = -1;
  let latestLocalInboundIdx = -1;
  let latestReplyIdx = -1;
  let latestProseIdx = -1;

  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // A malformed line is not worth losing the whole guard over.
      return;
    }

    if (obj?.type === "user") {
      const content = textOf(obj?.message?.content);

      // Orang yang mengetik sendiri di terminal ini. Diperiksa PALING DULU
      // karena capnya yang paling bisa dipercaya: `origin.kind` dibubuhkan
      // Claude Code, bukan disimpulkan dari isi teks. Prompt yang MENYEBUT tag
      // `<channel source="...cc-plugin">` -- persis yang terjadi saat orang
      // menanyakan bug pada guard ini -- akan lolos sebagai inbound Telegram
      // kalau urutannya dibalik.
      //
      // Yang sengaja TIDAK dipakai: "tidak ada tanda channel maka berarti
      // terminal". Entri `<command-name>` milik slash command juga datang tanpa
      // origin, dan `send_slash` menerbitkan satu setiap kali bot mengganti nama
      // sesinya sendiri -- guard akan mematikan dirinya sendiri lewat satu
      // panggilan tool yang terlihat tidak berbahaya. Kalau suatu hari Claude
      // Code berhenti membubuhkan `origin`, cek ini berhenti mengenali giliran
      // terminal dan guard kembali terlalu galak; itu arah gagal yang benar,
      // karena arah sebaliknya adalah kesunyian yang tidak dijaga siapa pun.
      if (obj?.origin?.kind === "human") {
        latestLocalInboundIdx = idx;
        return;
      }

      // Pesan dari bot lain TIDAK PERNAH menjadi "inbound yang menunggu
      // jawaban": tujuannya bot lain, bukan Telegram. Menghitungnya akan
      // membuat guard menuntut `reply` ke chat user setiap kali dua bot
      // berbicara -- pengulangan W-14, kali ini dari sumber baru DI DALAM
      // plugin yang sama, yang penyempitan W-14 tidak bisa saring.
      //
      // Diperiksa SEBELUM viaOrigin/viaTag, karena keduanya akan berkata "ya"
      // untuk pesan ini: transportnya memang plugin yang sama.
      //
      // DICATAT, lalu dikecualikan -- bukan sekadar dikecualikan. Sebelum
      // 2026-08-07 baris ini hanya `return`, dan giliran antar-bot jadi
      // SETENGAH terlihat: tidak menggeser `latestInboundIdx`, tapi prosanya
      // tetap menggeser `latestProseIdx`. Yang setengah terlihat lebih
      // berbahaya daripada yang tidak terlihat sama sekali.
      if (content.includes(AGENT_TURN_MARKER)) {
        latestAgentInboundIdx = idx;
        return;
      }

      // Both signals must name THIS plugin, not merely "some channel".
      //
      // The first version tested `origin.kind === "channel"` and the bare
      // presence of the terse-turn marker, and blocked within an hour of
      // shipping: a session can have this plugin AND the old `telegram` plugin
      // connected at once, that plugin stamps the same marker, and its prompts
      // are channel-delivered too. The guard demanded a cc-plugin reply to a
      // conversation that had already been answered through the other plugin.
      //
      // Same family as the old system's sticky `telegramDriven` flag -- not
      // sticky across time, but bleeding across channels.
      const viaOrigin = String(obj?.origin?.server ?? "").includes(PLUGIN_ID);
      // Fallback for when Claude Code records no `origin`: the channel tag names
      // the server it came from. Still scoped to us, never "any channel".
      const viaTag = new RegExp(`<channel[^>]*source="[^"]*${PLUGIN_ID}`).test(content);
      if (viaOrigin || viaTag) {
        channelDriven = true;
        latestInboundIdx = idx;
      }
      return;
    }

    if (obj?.type === "assistant") {
      const content = obj?.message?.content;
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (part?.type === "tool_use" && part.name === REPLY_TOOL) latestReplyIdx = idx;
        // `thinking` sengaja tidak dihitung: ia tidak pernah dikirim ke user
        // maupun dibayar ulang di giliran berikutnya, jadi ia bukan hal yang
        // protokol ini larang.
        if (part?.type === "text" && typeof part.text === "string") {
          const t = part.text.trim();
          if (t.length > 0 && t !== ".") latestProseIdx = idx;
        }
      }
    }
  });

  return {
    channelDriven,
    latestInboundIdx,
    latestAgentInboundIdx,
    latestLocalInboundIdx,
    latestReplyIdx,
    latestProseIdx,
  };
}

/**
 * Nama aturan yang dijaga hook ini, dieja sebagai literal.
 *
 * SALINAN SENGAJA dari `src/server.ts`, sekelas dengan `AGENT_TURN_MARKER` di
 * atas dan karena alasan yang sama: hook hanya boleh mengimpor `node:`, dan itu
 * terukur -- versi pertama `session-start.ts` yang mengimpor modul engine tidak
 * pernah menyala sama sekali. Yang menutup jaraknya adalah TEST yang mengadu
 * daftar ini dengan `RULE_IDS`, bukan sebuah import.
 *
 * Yang disalin hanya NAMAnya, tidak pernah teks aturannya. Teks itu sudah
 * dibayar sekali di `instructions` dan masih ada di context AI saat teguran
 * datang; menyalinnya ke sini akan melahirkan salinan kedua yang bisa menyimpang
 * dari aslinya, dan tidak ada yang akan gagal saat itu terjadi.
 */
export const RULE_REPLY_REQUIRED = "reply-required";
export const RULE_NO_PROSE = "no-prose";

export function decideStop(
  a: TranscriptAnalysis,
  stopHookActive: boolean
): { block: boolean; reason?: string; rule?: string } {
  // Claude Code telling us we already blocked once. Blocking again would trap
  // the session in a loop it has no way out of.
  if (stopHookActive) return { block: false };
  if (!a.channelDriven || a.latestInboundIdx === -1) return { block: false };
  // Prosa itu milik giliran ANTAR-BOT, bukan lanjutan giliran Telegram.
  //
  // Sengaja SEMPIT, dan kesempitannya dibayar dengan satu test merah: versi
  // pertama perbaikan ini memulangkan `block:false` untuk SELURUH giliran
  // antar-bot, dan test yang sudah ada langsung menangkapnya -- pesan Telegram
  // yang BELUM dijawab lalu disusul pesan dari bot lain akan lolos tanpa
  // ditagih. Kewajiban membalas orang yang AFK tidak boleh gugur hanya karena
  // ada bot lain yang menyela.
  //
  // Yang dikecualikan cuma satu hal: LARANGAN PROSA-nya. Giliran antar-bot
  // memang dilarang menjawab dengan `reply`, jadi transcript adalah
  // satu-satunya tempat isinya boleh mendarat.
  const proseMilikGiliranAgent =
    a.latestAgentInboundIdx > a.latestInboundIdx && a.latestProseIdx > a.latestAgentInboundIdx;
  // Hal yang sama, pintu ketiga: prosa itu milik giliran TERMINAL, bukan
  // lanjutan giliran Telegram. Bentuknya sengaja dijiplak dari baris di atas --
  // dua pengecualian yang seharusnya bersaudara tapi ditulis dengan bentuk
  // berbeda akan menyimpang diam-diam saat salah satunya disentuh.
  //
  // Dan sama sempitnya: yang gugur HANYA larangan prosanya. Giliran terminal
  // tidak boleh memaafkan pesan Telegram yang belum dijawab -- orang yang AFK
  // tidak kehilangan haknya atas jawaban cuma karena ada yang membuka terminal
  // sesudah pesannya. Kesempitan itu dijaga satu test yang mengujinya langsung.
  const proseMilikGiliranTerminal =
    a.latestLocalInboundIdx > a.latestInboundIdx && a.latestProseIdx > a.latestLocalInboundIdx;
  // Positions, not a boolean: answering the first message and then going quiet
  // on the second is the exact failure worth catching.
  // Sudah membalas -- kewajiban utamanya terpenuhi. Tersisa satu pelanggaran
  // yang bentuknya justru KEBALIKAN dari kesunyian: giliran yang membalas TAPI
  // tetap menulis prosa ke transcript. Nobody reads it, dan ia terus dibayar di
  // tiap giliran berikutnya sesi ini.
  //
  // Kenapa ditegakkan di sini dan bukan dicegah: saat hook `Stop` berjalan,
  // prosanya sudah tertulis -- memblokir tidak menghapusnya. Yang dipotong
  // adalah PENGULANGANNYA, dan `stopHookActive` di atas menjamin teguran ini
  // datang paling banyak sekali per giliran.
  if (a.latestReplyIdx > a.latestInboundIdx) {
    if (a.latestProseIdx > a.latestInboundIdx && !proseMilikGiliranAgent && !proseMilikGiliranTerminal) {
      // NAMA ATURAN + IMPERATIF, tanpa mengulang alasannya (spec 2026-08-10
      // K-5). Alasannya sudah dibayar sekali di `instructions`, dan kalimat
      // aslinya masih ada di context AI di bawah judul `Rule no-prose:` --
      // mengulangnya di sini memindahkan biaya sekali-sesi menjadi biaya
      // per-kejadian, sekaligus melahirkan salinan kedua yang bisa menyimpang.
      //
      // Yang TIDAK boleh ikut dipangkas: nama tool. Pelajaran dari pengingat
      // penamaan sesi 2026-08-06 -- pengingat yang menyuruh sebuah TINDAKAN
      // harus ikut menyebut ALATnya, karena "AI pasti tahu caranya" terbukti
      // asumsi yang tidak berlaku (bot uji sempat membaca source code repo
      // sebelum menemukan tool yang dimaksud).
      return {
        block: true,
        rule: RULE_NO_PROSE,
        reason:
          `You broke rule \`${RULE_NO_PROSE}\`: you answered via \`reply\` (${REPLY_TOOL}) and ` +
          'then also wrote prose into the transcript. End the turn now with a single "." and ' +
          "nothing else. Do NOT explain this, and do NOT send another `reply` about it.",
      };
    }
    return { block: false };
  }

  return {
    block: true,
    rule: RULE_REPLY_REQUIRED,
    reason:
      `You broke rule \`${RULE_REPLY_REQUIRED}\`: nothing has gone out since the last message ` +
      `from the person. Send your answer now via the \`reply\` tool (${REPLY_TOOL}), then end ` +
      "the turn.",
  };
}

/**
 * Parses the hook payload, tolerating a leading UTF-8 BOM.
 *
 * The BOM matters more than it looks: with one in front, JSON.parse throws,
 * main() returns early, and the guard does nothing at all -- while remaining
 * perfectly installed and enabled. A hook whose whole purpose is "never fail
 * silently" must not be silently disarmed by one invisible character. Third BOM
 * incident in this project (SCAR-026).
 *
 * Returns null rather than throwing, so a genuinely malformed payload cannot
 * take the hook down either.
 */
export function parseHookInput(raw: string): any | null {
  try {
    return JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/**
 * Satu baris catatan pelanggaran. Murni, jadi bentuknya bisa diuji tanpa disk.
 *
 * Sengaja JSONL dan bukan prosa: yang akan ditanyakan padanya adalah HITUNGAN
 * ("aturan mana yang paling sering dilanggar"), dan hitungan menuntut bentuk
 * yang bisa dibaca mesin. Prosa yang enak dibaca manusia harus di-parse ulang
 * dengan regex begitu ada yang benar-benar menghitungnya.
 */
export function violationLine(rule: string, sessionId: string | undefined, iso: string): string {
  return `${JSON.stringify({ ts: iso, rule, ...(sessionId !== undefined ? { session_id: sessionId } : {}) })}\n`;
}

/**
 * Menempelkan satu baris ke `logs/violations.jsonl` di folder bot.
 *
 * Menumpang pola yang sudah dipakai `session-start.ts` (`logs/session-hook.log`),
 * TERMASUK `try/catch` yang menelan segalanya: pencatatan tidak boleh pernah
 * menjadi penyebab hook ini gagal. Yang dijaga hook adalah kesunyian ke user;
 * kehilangan satu baris log jauh lebih murah daripada kehilangan teguran.
 *
 * Belum ada yang membacanya, dan itu disengaja (spec 2026-08-10, bagian 5):
 * menambah pembaca berarti menambah keputusan tentang apa yang ditampilkan dan
 * di mana, dan itu belum perlu.
 */
function recordViolation(botHome: string, rule: string, sessionId: string | undefined): void {
  try {
    const dir = join(botHome, "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "violations.jsonl"), violationLine(rule, sessionId, new Date().toISOString()));
  } catch {
    // Sengaja bisu.
  }
}

function main(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  const input = parseHookInput(raw);
  if (input === null) return;
  if (input?.stop_hook_active === true) return;

  const path = input?.transcript_path;
  if (typeof path !== "string") return;

  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return;
  }

  const decision = decideStop(analyzeTranscript(lines), false);
  if (!decision.block) return;
  // Teguran keluar LEBIH DULU. Ia satu-satunya keluaran yang menanggung tugas
  // hook ini; catatannya menyusul, dan kalaupun gagal tidak ada yang hilang
  // selain satu baris angka.
  process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
  if (decision.rule !== undefined) {
    const botHome = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const sessionId = typeof input?.session_id === "string" ? input.session_id : undefined;
    recordViolation(botHome, decision.rule, sessionId);
  }
}

if (import.meta.main) main();
