import { describe, test, expect } from "bun:test";
import { analyzeTranscript, decideStop, AGENT_TURN_MARKER } from "../hooks/reply-guard";
import { USER_TURN_MARKER } from "../src/server";

/**
 * Direproduksi dari kejadian NYATA di `mirza_02_bot`, 2026-08-07 06:54 UTC.
 *
 * Urutannya persis begini: user mengirim pesan Telegram, bot membalasnya lewat
 * `reply` (kewajibannya TUNTAS), lalu 23 menit kemudian datang pesan dari
 * bot lain. Bot MENOLAK menjalankannya -- keputusan yang benar, neighbor
 * autonomy -- dan menulis alasannya sebagai prosa.
 *
 * Hook `Stop` lalu memblokir dengan kalimat "you already answered via reply",
 * padahal di giliran ITU bot tidak memanggil `reply` sama sekali. Akibatnya
 * bukan cuma kalimat yang keliru: cabang itu menyuruh bot DIAM dan melarangnya
 * mengirim `reply` susulan -- jadi penolakannya tidak pernah sampai ke siapa
 * pun, dan tidak ada yang terlihat gagal.
 *
 * AKAR: pengecualian pesan-dari-bot hanya dipasang di SATU dari dua penanda.
 * Giliran dari bot tidak memperbarui `latestInboundIdx`, tapi prosanya TETAP
 * memperbarui `latestProseIdx`. Prosa milik giliran antar-bot karena itu
 * ditimpakan ke giliran Telegram sebelumnya.
 *
 * Bentuknya sama dengan dua bug lain di hari yang sama: pengecualian dipasang
 * di pintu, tidak dipasang di jendela.
 */
const inboundTelegram = () =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content:
        `<channel source="plugin:cc-plugin:cc-plugin" chat_id="111" message_id="94">\n` +
        `${USER_TURN_MARKER}\nngobrol santai dong\n</channel>`,
    },
    origin: { kind: "channel", server: "plugin:cc-plugin:cc-plugin" },
  });

const replyTurn = () =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "mcp__plugin_cc-plugin_cc-plugin__reply", input: {} }],
    },
  });

const inboundAgent = () =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content:
        `<channel source="plugin:cc-plugin:cc-plugin" origin="agent" from_bot="bot-03" ` +
        `hop_count="1">\n${AGENT_TURN_MARKER}\ntolong panggil agent_status\n</channel>`,
    },
    origin: { kind: "channel", server: "plugin:cc-plugin:cc-plugin" },
  });

const proseTurn = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

const TURN_AGENT = [inboundTelegram(), replyTurn(), inboundAgent(), proseTurn("Tidak aku jalankan.")];

describe("giliran yang dipicu bot lain", () => {
  test("dikenali sebagai giliran antar-bot, bukan lanjutan giliran Telegram", () => {
    const a = analyzeTranscript(TURN_AGENT);
    // Penandanya harus SAMA-SAMA tahu bahwa giliran terakhir milik bot lain.
    // Kalau cuma satu yang tahu, yang satunya akan menjawab untuk giliran yang salah.
    expect(a.latestAgentInboundIdx).toBe(2);
    expect(a.latestAgentInboundIdx).toBeGreaterThan(a.latestInboundIdx);
  });

  // Inti perbaikannya.
  test("prosa di giliran antar-bot TIDAK diblokir -- transcript memang satu-satunya tempatnya", () => {
    expect(decideStop(analyzeTranscript(TURN_AGENT), false).block).toBe(false);
  });

  test("tidak menuduh 'sudah membalas lewat reply' untuk giliran yang tidak memanggil reply", () => {
    expect(decideStop(analyzeTranscript(TURN_AGENT), false).reason ?? "").not.toContain(
      "already answered"
    );
  });

  // Yang lama HARUS tetap berlaku: begitu pesan Telegram berikutnya datang,
  // kewajiban membalas hidup lagi. Pengecualian ini soal GILIRAN, bukan sesi.
  test("pesan Telegram SESUDAH giliran antar-bot tetap menuntut reply", () => {
    const lines = [...TURN_AGENT, inboundTelegram()];
    const d = decideStop(analyzeTranscript(lines), false);
    expect(d.block).toBe(true);
    expect(d.reason).toContain("AFK");
  });

  test("prosa sesudah reply di giliran TELEGRAM tetap diblokir seperti sebelumnya", () => {
    const lines = [inboundTelegram(), replyTurn(), proseTurn("penjelasan panjang")];
    const d = decideStop(analyzeTranscript(lines), false);
    expect(d.block).toBe(true);
    expect(d.reason).toContain("already answered");
  });
});
