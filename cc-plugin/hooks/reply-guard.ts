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
import { readFileSync } from "node:fs";

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
export const AGENT_TURN_MARKER = "[protocol: agent-turn]";

export interface TranscriptAnalysis {
  channelDriven: boolean;
  latestInboundIdx: number;
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

      // Pesan dari bot lain TIDAK PERNAH menjadi "inbound yang menunggu
      // jawaban": tujuannya bot lain, bukan Telegram. Menghitungnya akan
      // membuat guard menuntut `reply` ke chat user setiap kali dua bot
      // berbicara -- pengulangan W-14, kali ini dari sumber baru DI DALAM
      // plugin yang sama, yang penyempitan W-14 tidak bisa saring.
      //
      // Diperiksa SEBELUM viaOrigin/viaTag, karena keduanya akan berkata "ya"
      // untuk pesan ini: transportnya memang plugin yang sama.
      if (content.includes(AGENT_TURN_MARKER)) return;

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

  return { channelDriven, latestInboundIdx, latestReplyIdx, latestProseIdx };
}

export function decideStop(
  a: TranscriptAnalysis,
  stopHookActive: boolean
): { block: boolean; reason?: string } {
  // Claude Code telling us we already blocked once. Blocking again would trap
  // the session in a loop it has no way out of.
  if (stopHookActive) return { block: false };
  if (!a.channelDriven || a.latestInboundIdx === -1) return { block: false };
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
    if (a.latestProseIdx > a.latestInboundIdx) {
      return {
        block: true,
        reason:
          "This turn is under the terse-turn protocol and you already answered via " +
          `\`reply\` (${REPLY_TOOL}) -- but you also wrote prose into the transcript. ` +
          "Nobody reads it: the person is on Telegram, and every later turn of this " +
          'session keeps paying for those tokens. End the turn with a single "." and ' +
          "nothing else. Do NOT explain this, and do NOT send another `reply` about it.",
      };
    }
    return { block: false };
  }

  return {
    block: true,
    reason:
      "This message came from Telegram and the person who sent it is AFK -- they do not see this " +
      "transcript. You have not sent a reply since their last message. Send your answer now via " +
      `the \`reply\` tool (${REPLY_TOOL}), then end the turn.`,
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
  process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
}

if (import.meta.main) main();
