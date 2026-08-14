import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelTagAttrs, readTurnOrigin, triggerOfCurrentTurn } from "../../src/engine/turn-origin";

/**
 * "Giliran ini dipicu apa" dibaca dari transcript Claude Code.
 *
 * Bentuk baris di bawah BUKAN karangan: semuanya disalin dari transcript
 * produksi yang sungguhan (bot-02 dan bot-05, 2026-08-13/14). Baris palsu yang
 * "kira-kira begitu" akan membuat seluruh berkas ini hijau untuk format yang
 * tidak pernah ditulis Claude Code -- kelas kegagalan yang sama dengan guard
 * yang terpasang rapi sambil tidak menjaga apa pun.
 */

/** Push antar-bot: `origin="agent"` + `from_bot` ada DI ATRIBUT tag channel. */
function agentPush(fromBot: string): string {
  return JSON.stringify({
    type: "user",
    isMeta: true,
    origin: { kind: "channel", server: "plugin:cc-plugin:cc-plugin" },
    message: {
      role: "user",
      content:
        `<channel source="plugin:cc-plugin:cc-plugin" origin="agent" from_bot="${fromBot}" ` +
        `agent_message_id="93fbde34" ts="2026-08-13T04:16:00.000Z" expects_reply="true" ` +
        `hop_count="0">\n[from: agent]\nHalo, ini titipan kerjaan.`,
    },
  });
}

/** Push Telegram biasa: tag yang sama, tapi tanpa `origin="agent"`. */
function userPush(text: string): string {
  return JSON.stringify({
    type: "user",
    isMeta: true,
    origin: { kind: "channel", server: "plugin:cc-plugin:cc-plugin" },
    message: {
      role: "user",
      content:
        `<channel source="plugin:cc-plugin:cc-plugin" chat_id="1121398977" user_id="1121398977" ` +
        `ts="2026-08-14T05:37:07.000Z" kind="message">\n[from: user]\n${text}`,
    },
  });
}

/**
 * Pemicu monitor periodik -- INTI bug yang berkas ini kunci.
 *
 * Terukur: transcript bot-02 `80f4927e` baris 1016, giliran yang menerbitkan
 * laporan sweep `django__django-13321` (conversations.db baris 179). Pemicunya
 * event Monitor, bukan bot mana pun; pesannya tetap kena penanda "Dipicu oleh
 * bot lain (bot-04)" karena origin lama nyangkut di ingatan proses.
 */
function taskNotification(): string {
  return JSON.stringify({
    type: "user",
    origin: { kind: "task-notification" },
    message: {
      role: "user",
      content: "<task-notification>\n<summary>Monitor event: sweep verdict</summary>\n",
    },
  });
}

/** Giliran yang DIKETIK orangnya di terminal bot. */
function terminalTurn(text: string): string {
  return JSON.stringify({
    type: "user",
    origin: { kind: "human" },
    message: { role: "user", content: text },
  });
}

/** Hasil tool: `type:"user"` juga, dan jumlahnya jauh melebihi pemicu asli. */
function toolResult(): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "ok", is_error: false }] },
  });
}

/** Sisipan TENGAH giliran (isi skill, system-reminder): user, tapi tanpa origin. */
function midTurnInjection(text: string): string {
  return JSON.stringify({
    type: "user",
    isMeta: true,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function assistantTurn(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

// ---------------------------------------------------------------------------
// channelTagAttrs
// ---------------------------------------------------------------------------

test("channelTagAttrs: memungut atribut dari tag channel pembuka", () => {
  const attrs = channelTagAttrs(
    '<channel source="plugin:cc-plugin:cc-plugin" origin="agent" from_bot="bot-04">\nhalo'
  );
  expect(attrs).not.toBeNull();
  expect(attrs!.origin).toBe("agent");
  expect(attrs!.from_bot).toBe("bot-04");
});

// Tag yang disebut di TENGAH kalimat bukan tag pembuka -- ia cuma teks yang
// kebetulan berbentuk sama. Persis yang terjadi tiap kali seseorang bertanya
// tentang bug ini kepada botnya sendiri.
test("channelTagAttrs: null kalau tag cuma DISEBUT di tengah teks", () => {
  expect(channelTagAttrs('kenapa <channel source="x" origin="agent"> muncul?')).toBeNull();
});

// ---------------------------------------------------------------------------
// triggerOfCurrentTurn
// ---------------------------------------------------------------------------

test("pemicu push antar-bot -> agent, dengan nama bot dari atribut tag", () => {
  expect(triggerOfCurrentTurn([userPush("halo"), agentPush("bot-04"), assistantTurn("kerja")])).toEqual(
    { kind: "agent", fromBot: "bot-04" }
  );
});

test("pemicu push Telegram biasa -> user", () => {
  expect(triggerOfCurrentTurn([agentPush("bot-04"), userPush("halo")])).toEqual({ kind: "user" });
});

// REGRESI PRODUKSI. Monitor periodik menerbitkan laporannya sendiri; pemicunya
// event Monitor, dan push antar-bot yang lama TIDAK boleh ikut terbawa.
test("regresi: monitor periodik sesudah push antar-bot -> user, bukan agent", () => {
  const lines = [
    agentPush("bot-04"),
    assistantTurn("balasan untuk bot-04"),
    taskNotification(),
    assistantTurn("laporan sweep"),
  ];
  expect(triggerOfCurrentTurn(lines)).toEqual({ kind: "user" });
});

// Batasan yang selama ini dicatat sadar di komentar buildAgentOriginMarker --
// sekarang ikut tertutup, karena Claude Code sendiri yang mencapkan
// `origin.kind === "human"` pada giliran terminal.
test("giliran yang diketik di terminal sesudah push antar-bot -> user", () => {
  expect(triggerOfCurrentTurn([agentPush("bot-04"), terminalTurn("balas dia ya")])).toEqual({
    kind: "user",
  });
});

// Hasil tool dan sisipan tengah giliran juga `type:"user"`. Kalau mereka ikut
// dihitung sebagai pemicu, penanda hilang di SETIAP giliran yang memakai tool
// atau skill -- yaitu hampir semuanya.
test("hasil tool dan sisipan tengah giliran dilewati, pemicu asli tetap terbaca", () => {
  const lines = [
    agentPush("bot-04"),
    assistantTurn("mulai"),
    toolResult(),
    midTurnInjection("Base directory for this skill: ..."),
    toolResult(),
  ];
  expect(triggerOfCurrentTurn(lines)).toEqual({ kind: "agent", fromBot: "bot-04" });
});

// Satu sesi bisa punya beberapa plugin channel sekaligus. Penanda ini cuma
// berhak bicara untuk jalurnya sendiri (pelajaran yang sama sudah dibayar
// reply-guard: sinyal "ada channel" tidak sama dengan "channel kita").
test("push dari plugin channel LAIN -> user", () => {
  const lain = JSON.stringify({
    type: "user",
    origin: { kind: "channel", server: "plugin:telegram:telegram" },
    message: { role: "user", content: '<channel source="plugin:telegram:telegram" origin="agent">\nhalo' },
  });
  expect(triggerOfCurrentTurn([agentPush("bot-04"), lain])).toEqual({ kind: "user" });
});

// `null` BUKAN "user": ia berarti "tidak tahu", dan pemanggil menjatuhkannya ke
// perilaku lama. Dua keadaan itu tidak boleh diwakili satu nilai yang sama.
test("transcript tanpa satu pun pemicu -> null (tidak tahu), bukan user", () => {
  expect(triggerOfCurrentTurn([assistantTurn("a"), toolResult(), ""])).toBeNull();
});

test("baris rusak tidak menjatuhkan pembacaan", () => {
  expect(triggerOfCurrentTurn([agentPush("bot-04"), "{bukan json", toolResult()])).toEqual({
    kind: "agent",
    fromBot: "bot-04",
  });
});

// Pesan antar-bot yang tag-nya entah bagaimana kehilangan `from_bot` tetap
// harus ditandai -- yang hilang cuma namanya, bukan faktanya.
test("push antar-bot tanpa from_bot -> tetap agent, nama generik", () => {
  const tanpaNama = JSON.stringify({
    type: "user",
    origin: { kind: "channel", server: "plugin:cc-plugin:cc-plugin" },
    message: {
      role: "user",
      content: '<channel source="plugin:cc-plugin:cc-plugin" origin="agent">\n[from: agent]\nhalo',
    },
  });
  expect(triggerOfCurrentTurn([tanpaNama])).toEqual({ kind: "agent", fromBot: "bot lain" });
});

// ---------------------------------------------------------------------------
// readTurnOrigin
// ---------------------------------------------------------------------------

test("readTurnOrigin: membaca berkas transcript sungguhan", () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-origin-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, `${agentPush("bot-07")}\n${toolResult()}\n`, "utf8");
  expect(readTurnOrigin(p)).toEqual({ kind: "agent", fromBot: "bot-07" });
});

// Transcript yang belum ada bukan kerusakan -- ia cuma "belum tahu", dan
// pemanggil masih punya jawaban cadangan.
test("readTurnOrigin: berkas tidak ada -> null", () => {
  expect(readTurnOrigin(join(tmpdir(), "tidak-ada-sama-sekali.jsonl"))).toBeNull();
});
