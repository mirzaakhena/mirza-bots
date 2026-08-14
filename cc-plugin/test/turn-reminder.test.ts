import { describe, test, expect } from "bun:test";
import { buildTurnReminder, RULE_BUTTONS_WHEN_PICKABLE } from "../hooks/turn-reminder";
import { RULE_IDS } from "../src/server";

const promptKanal = (penanda: string) =>
  `<channel source="plugin:cc-plugin:cc-plugin" chat_id="111" user_id="111" ` +
  `kind="message" message_id="9">\n${penanda}\nhalo\n</channel>`;

describe("buildTurnReminder", () => {
  // Giliran yang diketik langsung di terminal, atau giliran plugin lain.
  // Pengingat yang menyala di sana mengajarkan bahwa penanda di sini kadang
  // tidak berarti apa-apa.
  test("diam pada prompt tanpa tag channel milik plugin ini", () => {
    expect(buildTurnReminder("tolong benerin bug di parser")).toBeNull();
  });

  test("diam pada tag channel milik plugin LAIN", () => {
    expect(
      buildTurnReminder('<channel source="plugin:telegram:telegram" chat_id="1">hai</channel>')
    ).toBeNull();
  });

  // Aturan `inter-bot-channel` melarang `reply` sama sekali di giliran ini.
  // Mengingatkan soal tombol di sana adalah menyuruh melakukan hal yang aturan
  // lain melarang. reply-guard sudah membayar pelajaran ini dengan bug nyata:
  // pengecualian yang dipasang di satu penanda saja menjaga pintu sambil
  // membuka jendela.
  test("diam pada giliran antar-bot meski tag channelnya ada", () => {
    expect(buildTurnReminder(promptKanal("[from: agent]"))).toBeNull();
  });

  test("menyala pada giliran Telegram, dan menyebut aturan serta parameternya", () => {
    const r = buildTurnReminder(promptKanal("[from: user]"));
    expect(r).not.toBeNull();
    expect(r!).toContain(RULE_BUTTONS_WHEN_PICKABLE);
    expect(r!).toContain("`buttons`");
    expect(r!).toContain("`reply`");
  });

  // BUKAN bug yang ditest sebagai fitur. Hook UserPromptSubmit hanya menerima
  // { prompt }, tanpa transcript, jadi sinyal `origin` yang dipakai reply-guard
  // tidak tersedia di sini -- yang tersisa cuma regex tag. Harganya satu baris
  // pengingat yang tidak relevan, bukan giliran yang mati, karena hook ini
  // tidak memblokir apa pun. Dikunci supaya tidak "diperbaiki" tanpa membaca
  // kenapa.
  test("ikut menyala saat prompt cuma MENYEBUT tag itu -- konsekuensi yang disengaja", () => {
    expect(
      buildTurnReminder('kenapa hook-nya nyala kalau ada <channel source="plugin:cc-plugin:cc-plugin">?')
    ).not.toBeNull();
  });
});

// Pengganti impor yang dilarang. Tanpa test ini, mengganti nama aturan di
// server.ts membuat hook menyebut nama yang tidak lagi ada, dan tidak ada yang
// gagal. Idiom yang sama dipakai AGENT_TURN_MARKER di reply-guard.
test("rule-id yang dieja hook ada di daftar sumbernya", () => {
  expect(RULE_IDS).toContain(RULE_BUTTONS_WHEN_PICKABLE);
});
