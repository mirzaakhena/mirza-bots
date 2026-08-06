import { describe, test, expect } from "bun:test";
import { analyzeTranscript, decideStop, parseHookInput } from "../hooks/reply-guard";
import { TERSE_TURN_MARKER, AGENT_TURN_MARKER } from "../src/server";
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
        `kind="message" message_id="${messageId}">\n${TERSE_TURN_MARKER}\nhalo\n</channel>`,
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

const typedByUser = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });

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
        content: `<channel source="plugin:telegram:telegram" chat_id="111">\n${TERSE_TURN_MARKER}\nhalo\n</channel>`,
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
    expect(decision.reason).toContain("terse-turn");
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
