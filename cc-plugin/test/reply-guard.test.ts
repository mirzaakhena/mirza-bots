import { describe, test, expect } from "bun:test";
import {
  analyzeTranscript,
  decideStop,
  parseHookInput,
  violationLine,
  RULE_NO_PROSE,
  RULE_REPLY_REQUIRED,
} from "../hooks/reply-guard";
import { RULE_IDS } from "../src/server";
import { USER_TURN_MARKER, AGENT_TURN_MARKER } from "../src/server";
import { AGENT_TURN_MARKER as GUARD_AGENT_MARKER } from "../hooks/reply-guard";

// Shapes below are copied from a REAL transcript
// (~/.claude/projects/<project>/<session>.jsonl, 2026-08-01), not invented. The
// difference that matters: an inbound channel message arrives with
// `message.content` as a STRING, while an assistant turn carries an ARRAY of
// parts. A guard that only understands the array form silently sees no inbound
// at all -- installed, and doing nothing.
const inbound = (messageId: string) =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content:
        `<channel source="plugin:cc-plugin:cc-plugin" chat_id="111" user_id="111" ` +
        `kind="message" message_id="${messageId}">\n${USER_TURN_MARKER}\nhalo\n</channel>`,
    },
    isMeta: true,
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

// `origin: { kind: "human" }` BUKAN hiasan. Itulah satu-satunya cap yang Claude
// Code bubuhkan pada giliran yang benar-benar DIKETIK orang di terminal, dan
// bentuk ini disalin dari transcript asli
// (~/.claude/projects/<project>/<session>.jsonl, 2026-08-11 02:12), bukan
// dikarang. Versi lama helper ini tidak memuatnya, dan akibatnya test yang
// seharusnya menjaga giliran terminal justru menguji sesuatu yang tidak pernah
// ada di dunia nyata -- hijau tanpa menjaga apa pun.
const typedByUser = (text: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    origin: { kind: "human" },
  });

const plainAssistantTurn = () =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "." }] },
  });

describe("analyzeTranscript", () => {
  test("recognizes a channel inbound even though its content is a bare string", () => {
    // The whole point: the old system's guard required Array.isArray(content) and
    // would have scored this transcript as "no Telegram inbound, nothing to do".
    const a = analyzeTranscript([inbound("32")]);

    expect(a.channelDriven).toBe(true);
    expect(a.latestInboundIdx).toBe(0);
    expect(a.latestReplyIdx).toBe(-1);
  });

  test("records the reply tool call, and only that tool", () => {
    const a = analyzeTranscript([inbound("32"), plainAssistantTurn(), replyTurn()]);

    expect(a.latestReplyIdx).toBe(2);
  });

  test("ignores a channel inbound that belongs to a DIFFERENT plugin", () => {
    // Found in production 2026-08-01, within an hour of shipping the guard: a
    // session can have BOTH this plugin and the old `telegram` plugin connected.
    // That plugin now stamps the same terse-turn marker and its prompts also
    // arrive with origin.kind === "channel", so the first version of this guard
    // blocked on ITS messages -- looking for a cc-plugin reply that was never
    // going to exist, because the answer had correctly gone out through the other
    // plugin. Same family as the old system's sticky `telegramDriven` flag: not
    // sticky across time, but bleeding across channels.
    const foreign = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: `<channel source="plugin:telegram:telegram" chat_id="111">\n${USER_TURN_MARKER}\nhalo\n</channel>`,
      },
      origin: { kind: "channel", server: "plugin:telegram:telegram" },
    });

    const a = analyzeTranscript([foreign]);

    expect(a.channelDriven).toBe(false);
    expect(a.latestInboundIdx).toBe(-1);
  });

  test("still recognizes our own inbound when it sits next to another plugin's", () => {
    const foreign = JSON.stringify({
      type: "user",
      message: { role: "user", content: "<channel source=\"plugin:telegram:telegram\">hai</channel>" },
      origin: { kind: "channel", server: "plugin:telegram:telegram" },
    });

    const a = analyzeTranscript([foreign, inbound("32"), foreign]);

    // The foreign message AFTER ours must not move the anchor either -- otherwise
    // the guard would demand a cc-plugin reply to someone else's conversation.
    expect(a.channelDriven).toBe(true);
    expect(a.latestInboundIdx).toBe(1);
  });

  test("a turn the user typed in the terminal is not a channel inbound", () => {
    // D-1 in reverse: this guard must never fire for ordinary terminal work,
    // where there is no AFK human waiting on a Telegram message.
    const a = analyzeTranscript([typedByUser("tolong perbaiki bug ini")]);

    expect(a.channelDriven).toBe(false);
    expect(a.latestInboundIdx).toBe(-1);
  });

  test("survives malformed lines instead of throwing the hook away", () => {
    // A hook that crashes is a hook that silently stops guarding.
    const a = analyzeTranscript(["", "not json at all", "{}", inbound("32")]);

    expect(a.channelDriven).toBe(true);
    expect(a.latestInboundIdx).toBe(3);
  });
});

describe("parseHookInput", () => {
  test("parses an ordinary payload", () => {
    expect(parseHookInput('{"transcript_path":"/x.jsonl"}')).toEqual({ transcript_path: "/x.jsonl" });
  });

  test("parses a payload carrying a UTF-8 BOM instead of giving up on it", () => {
    // Found the hard way on Windows 2026-08-01: a BOM on stdin makes JSON.parse
    // throw, main() return early, and the guard do nothing -- while looking
    // perfectly installed. For a hook whose entire job is "never fail silently",
    // silently failing to read its own input is the worst possible bug. This is
    // the third BOM incident in this project (SCAR-026).
    expect(parseHookInput('﻿{"transcript_path":"/x.jsonl"}')).toEqual({
      transcript_path: "/x.jsonl",
    });
  });

  test("returns null for genuine garbage rather than throwing out of the hook", () => {
    expect(parseHookInput("not json")).toBeNull();
    expect(parseHookInput("")).toBeNull();
  });
});

describe("decideStop", () => {
  test("blocks when the newest inbound has no reply after it", () => {
    const decision = decideStop(analyzeTranscript([inbound("32")]), false);

    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("reply");
    expect(decision.rule).toBe(RULE_REPLY_REQUIRED);
  });

  test("does not block once a reply followed the inbound", () => {
    const decision = decideStop(analyzeTranscript([inbound("32"), replyTurn()]), false);

    expect(decision.block).toBe(false);
  });

  test("blocks again when a NEWER inbound arrives after the last reply", () => {
    // The failure this guard exists for: answering the first message, then going
    // quiet on the second. Comparing positions rather than a boolean is what
    // catches it.
    const decision = decideStop(
      analyzeTranscript([inbound("32"), replyTurn(), inbound("33")]),
      false
    );

    expect(decision.block).toBe(true);
  });

  test("never blocks twice in a row", () => {
    // stop_hook_active is Claude Code telling us we already blocked once. Without
    // this the session would be trapped in a loop it cannot leave.
    const decision = decideStop(analyzeTranscript([inbound("32")]), true);

    expect(decision.block).toBe(false);
  });

  test("stays out of the way of a purely terminal session", () => {
    const decision = decideStop(analyzeTranscript([typedByUser("halo")]), false);

    expect(decision.block).toBe(false);
  });
});

// Pesan antar-bot lewat transport yang SAMA (MCP push dari plugin yang sama),
// jadi `origin.server` memuat "cc-plugin" persis seperti pesan Telegram.
// Penyempitan yang dulu memperbaiki W-14 -- membatasi guard ke plugin sendiri --
// tidak menolong untuk sumber baru DI DALAM plugin yang sama. Yang membedakan
// hanyalah penanda di teksnya, karena teks itulah satu-satunya yang guard lihat.
const agentInbound = (from: string) =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content:
        `<channel source="plugin:cc-plugin:cc-plugin" origin="agent" from_bot="${from}">\n` +
        `${AGENT_TURN_MARKER}\nkerjakan X\n</channel>`,
    },
    isMeta: true,
    origin: { kind: "channel", server: "plugin:cc-plugin:cc-plugin" },
  });

describe("pesan antar-bot bukan inbound Telegram", () => {
  // K-15: dua literal yang harus sama akan menyimpang diam-diam. Hook tidak
  // boleh mengimpor dari src/ (hanya `node:`), jadi yang menutup jaraknya adalah
  // test ini, bukan sebuah import.
  test("penanda di hook identik dengan yang ditulis server", () => {
    expect(GUARD_AGENT_MARKER).toBe(AGENT_TURN_MARKER);
  });

  test("pesan antar-bot TIDAK membuat guard menuntut balasan Telegram", () => {
    const decision = decideStop(analyzeTranscript([agentInbound("bot-03")]), false);

    expect(decision.block).toBe(false);
  });

  // Yang paling mudah salah: pesan Telegram yang BELUM dijawab tidak boleh ikut
  // terhapus hanya karena sesudahnya datang pesan antar-bot.
  test("pesan Telegram yang belum dijawab tetap diblokir meski disusul pesan antar-bot", () => {
    const decision = decideStop(
      analyzeTranscript([inbound("32"), agentInbound("bot-03")]),
      false
    );

    expect(decision.block).toBe(true);
  });

  test("pesan Telegram yang sudah dijawab tetap tidak diblokir", () => {
    const decision = decideStop(
      analyzeTranscript([inbound("32"), replyTurn(), agentInbound("bot-03")]),
      false
    );

    expect(decision.block).toBe(false);
  });
});

// Keputusan user 2026-08-06: pelanggaran terse-turn "langsung tegakkan", bukan
// diukur dulu. Yang ditegakkan bukan kesunyian (itu tetangga di atas) melainkan
// kebalikannya -- giliran yang SUDAH membalas lewat `reply` tapi tetap menulis
// prosa di transcript, yang tidak dibaca siapa pun dan terus dibayar tokennya di
// tiap giliran berikutnya.
const proseTurn = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

describe("pelanggaran terse-turn", () => {
  test("prosa sesudah inbound tercatat posisinya", () => {
    const a = analyzeTranscript([inbound("32"), replyTurn(), proseTurn("Jadi begini penjelasannya")]);

    expect(a.latestProseIdx).toBe(2);
  });

  test("titik tunggal adalah kepatuhan, bukan prosa", () => {
    const a = analyzeTranscript([inbound("32"), replyTurn(), proseTurn(".")]);

    expect(a.latestProseIdx).toBe(-1);
  });

  test("giliran yang sudah membalas TAPI menulis prosa diblokir", () => {
    const decision = decideStop(
      analyzeTranscript([inbound("32"), replyTurn(), proseTurn("Jadi begini penjelasannya")]),
      false
    );

    expect(decision.block).toBe(true);
    // Dulu menuntut kata "terse-turn". Sejak spec 2026-08-10 pesan teguran
    // menyebut NAMA ATURAN, dan nama itulah yang harus sampai -- ia yang bisa
    // dirujuk balik ke kalimat aslinya di `instructions`, dan ia juga yang
    // dicatat ke `logs/violations.jsonl`.
    expect(decision.rule).toBe(RULE_NO_PROSE);
    expect(decision.reason).toContain(RULE_NO_PROSE);
  });

  test("prosa dari giliran LAMA tidak menghukum giliran sekarang", () => {
    const decision = decideStop(
      analyzeTranscript([proseTurn("giliran terminal biasa"), inbound("32"), replyTurn()]),
      false
    );

    expect(decision.block).toBe(false);
  });

  test("tidak diblokir dua kali -- stopHookActive memutus loop", () => {
    const decision = decideStop(
      analyzeTranscript([inbound("32"), replyTurn(), proseTurn("Jadi begini penjelasannya")]),
      true
    );

    expect(decision.block).toBe(false);
  });
});

// Pengulangan KETIGA dari satu kekeliruan yang sama: guard hanya mengenal dua
// pintu masuk -- Telegram dan bot lain -- lalu memperlakukan SEMUA prosa
// sesudahnya sebagai milik giliran Telegram terakhir. Pintu ketiga, orang yang
// duduk di depan terminal ini dan mengetik sendiri, tidak pernah dicatat, jadi
// jangkar `latestInboundIdx` tidak pernah bergerak dan giliran terminal
// mewarisi kewajiban milik giliran Telegram yang sudah lama selesai.
//
// Terukur, bukan dugaan: transcript bot-02 `6ad8b29d` 2026-08-11 -- pesan
// Telegram di baris 1012, `reply` di 1022, giliran yang diketik di terminal di
// 1052 (02:12), prosa jawabannya di 1107 (02:51). `decideStop` atas transcript
// itu memulangkan `no-prose`, menyuruh giliran terminal DIAM dan menutup diri
// dengan satu titik -- padahal transcript adalah satu-satunya tempat jawaban
// giliran itu bisa mendarat. Rule `no-prose` justru memakan jawaban yang benar.
describe("giliran yang diketik di terminal", () => {
  test("giliran terminal tercatat posisinya, terpisah dari inbound Telegram", () => {
    const a = analyzeTranscript([inbound("32"), replyTurn(), typedByUser("lanjut yang tadi")]);

    expect(a.latestLocalInboundIdx).toBe(2);
    // Jangkar Telegram TIDAK boleh ikut bergeser: kalau ikut, pesan Telegram
    // yang belum dijawab akan terhapus kewajibannya cuma karena user membuka
    // terminal.
    expect(a.latestInboundIdx).toBe(0);
  });

  test("prosa di giliran terminal TIDAK melanggar no-prose", () => {
    const decision = decideStop(
      analyzeTranscript([
        inbound("32"),
        replyTurn(),
        typedByUser("kenapa hook-nya nyala?"),
        proseTurn("Karena guard-nya tidak mengenal giliran terminal."),
      ]),
      false
    );

    expect(decision.block).toBe(false);
  });

  // Kesempitan yang disengaja, sama persis dengan precedent antar-bot: yang
  // digugurkan HANYA larangan prosanya. Orang yang AFK di Telegram tidak
  // kehilangan haknya atas jawaban cuma karena sesudah pesannya ada orang yang
  // mengetik di terminal.
  test("pesan Telegram yang belum dijawab tetap ditagih meski disusul giliran terminal", () => {
    const decision = decideStop(
      analyzeTranscript([inbound("32"), typedByUser("sebentar, kerjakan ini dulu")]),
      false
    );

    expect(decision.block).toBe(true);
    expect(decision.rule).toBe(RULE_REPLY_REQUIRED);
  });

  // Arah sebaliknya, dan ini yang paling mudah rusak: begitu pesan Telegram
  // BARU datang sesudah giliran terminal, larangan prosa harus hidup lagi.
  // Pengecualian yang tidak bisa dimatikan kembali sama saja dengan mencabut
  // aturannya.
  test("inbound Telegram yang lebih baru menghidupkan lagi larangan prosa", () => {
    const decision = decideStop(
      analyzeTranscript([
        typedByUser("kerjakan ini"),
        inbound("32"),
        replyTurn(),
        proseTurn("Jadi begini penjelasannya"),
      ]),
      false
    );

    expect(decision.block).toBe(true);
    expect(decision.rule).toBe(RULE_NO_PROSE);
  });

  // Yang dipercaya cuma cap `origin.kind === "human"` dari Claude Code, bukan
  // "tidak ada tanda channel maka berarti terminal". Entri `<command-name>`
  // milik slash command juga datang tanpa origin dan tanpa isMeta, dan
  // `send_slash` menerbitkan satu setiap kali bot mengganti nama sesinya
  // sendiri. Menghitungnya sebagai giliran terminal akan membuat bot mematikan
  // guard-nya sendiri, dengan satu panggilan tool yang terlihat tidak berbahaya.
  test("entri slash command bukan giliran terminal", () => {
    const slashEntry = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "<command-name>/rename</command-name>\n<command-args>halo</command-args>",
      },
    });

    const a = analyzeTranscript([inbound("32"), replyTurn(), slashEntry]);

    expect(a.latestLocalInboundIdx).toBe(-1);
  });

  // Teks yang diketik user tidak boleh bisa menyamar jadi pesan Telegram cuma
  // karena ia MENYEBUT tag channel -- dan menempelkan tag itu ke prompt adalah
  // hal yang wajar terjadi saat orang menanyakan bug pada guard ini sendiri.
  test("user yang menempelkan tag channel ke prompt tetap dihitung giliran terminal", () => {
    const pasted = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: 'kenapa `<channel source="plugin:cc-plugin:cc-plugin">` bikin hook nyala?',
      },
      origin: { kind: "human" },
    });

    const a = analyzeTranscript([pasted]);

    expect(a.channelDriven).toBe(false);
    expect(a.latestLocalInboundIdx).toBe(0);
  });
});

// INI PENGGANTI IMPORT YANG DILARANG.
//
// Hook hanya boleh mengimpor `node:` -- terukur, bukan selera: versi pertama
// session-start.ts yang mengimpor modul engine tidak pernah menyala sama sekali
// padahal terlihat terpasang. Jadi nama aturan HARUS dieja dua kali, di sini dan
// di src/server.ts, dan satu-satunya yang bisa menjaga keduanya tetap sama
// adalah test. Tanpanya, mengganti nama sebuah aturan membuat hook menyebut nama
// yang tidak lagi ada -- dan tidak ada yang gagal.
describe("nama aturan yang dieja hook tetap sama dengan yang di server.ts", () => {
  test("setiap id yang dirujuk hook benar-benar ada", () => {
    for (const id of [RULE_REPLY_REQUIRED, RULE_NO_PROSE]) {
      expect(RULE_IDS).toContain(id);
    }
  });
});

// Bentuk catatannya diuji terpisah dari penulisannya ke disk: yang bisa salah
// diam-diam adalah BENTUKNYA -- baris yang tidak bisa di-parse mesin -- bukan
// pemanggilan appendFileSync.
describe("violationLine", () => {
  test("satu baris JSON per pelanggaran, diakhiri newline", () => {
    const line = violationLine(RULE_NO_PROSE, "sesi-1", "2026-08-10T01:00:00.000Z");

    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      ts: "2026-08-10T01:00:00.000Z",
      rule: RULE_NO_PROSE,
      session_id: "sesi-1",
    });
  });

  // `session_id` yang tidak diketahui DIHILANGKAN, bukan ditulis sebagai
  // "undefined". Baris yang memuat string "undefined" akan terlihat seperti
  // sesi yang benar-benar bernama begitu saat nanti dihitung -- kekeliruan yang
  // sebentuk dengan yang dijaga forwarder push di server.ts.
  test("sesi yang tidak diketahui tidak melahirkan field palsu", () => {
    const parsed = JSON.parse(
      violationLine(RULE_REPLY_REQUIRED, undefined, "2026-08-10T01:00:00.000Z")
    );

    expect(parsed).toEqual({ ts: "2026-08-10T01:00:00.000Z", rule: RULE_REPLY_REQUIRED });
    expect("session_id" in parsed).toBe(false);
  });
});
