#!/usr/bin/env bun
/**
 * UserPromptSubmit hook: menyuntik ulang aturan tombol SETIAP giliran Telegram.
 *
 * ## Kenapa ini ada, dan kenapa tidak cukup di `INSTRUCTION_BLOCKS`
 *
 * Aturan di `instructions` dibaca SEKALI di awal sesi. Yang bocor bukan
 * pengetahuannya melainkan perhatiannya: aturan tombol terlupa justru pada
 * giliran yang pekerjaan utamanya hal lain, saat pertanyaannya menempel di
 * ekor sebagai penutup -- dan giliran padat adalah giliran yang paling jauh
 * dari bacaan awal sesi. Terukur tiga kali dalam satu sesi yang seluruh isinya
 * membahas tombol (spec 2026-08-11, T-8), ketiganya ditangkap user.
 *
 * Bentuk ini BUKAN gagasan baru. Sistem lama memakainya untuk aturan yang sama
 * persis, dan docstring-nya menyebut alasan yang sama: "re-injects the ambient
 * Telegram-channel obligations every turn (not just at SessionStart), so they
 * don't fade under task pressure". MCP `instructions` sistem lama sengaja tidak
 * menyebut tombol sama sekali -- penempatan di hook adalah pilihan sadar
 * perancangnya, bukan kelalaian yang kebetulan menolong.
 *
 * ## Kenapa BUKAN `engine/reminders.ts`
 *
 * Berkas itu punya syarat masuk: "kapan ia TIDAK menyala?" Pengingat ini
 * menyala di hampir setiap giliran Telegram, jadi ia gagal ujian itu. Tapi
 * doktrin tersebut menjaga SATU KANAL tertentu -- `[from: system]` -- dari
 * menjadi latar belakang. Hook ini menulis ke `additionalContext`, kanal yang
 * berbeda dan tidak ikut mendorong isi ke sana, jadi ambangnya tidak mengotori
 * kanal yang doktrin itu lindungi.
 *
 * ## Hanya `node:` yang boleh diimpor
 *
 * Bukan gaya: versi pertama `hooks/session-start.ts` yang mengimpor modul
 * engine tidak pernah menyala sama sekali padahal terlihat terpasang. Karena
 * itu rule-id di bawah adalah SALINAN, dan yang menutup jaraknya dengan
 * `RULE_IDS` di `src/server.ts` adalah sebuah test, bukan sebuah import.
 */
import { readFileSync } from "node:fs";

/** Cara Claude Code menamai server MCP plugin ini. */
const PLUGIN_ID = "cc-plugin";

/** Salinan sengaja dari `src/server.ts`. Diadu oleh test dengan `RULE_IDS`. */
export const RULE_BUTTONS_WHEN_PICKABLE = "buttons-when-pickable";

/** Salinan sengaja dari `src/server.ts`, alasan yang sama. */
export const AGENT_TURN_MARKER = "[from: agent]";

/**
 * `null` berarti tidak ada yang disuntik — bukan string kosong, karena blok
 * kosong tetap dibayar tokennya dan mengajari AI bahwa penanda itu kadang tidak
 * berarti apa-apa.
 *
 * Dua gerbang, dan urutannya tidak penting karena keduanya menolak, bukan
 * memilih. Yang penting keduanya ADA: pengecualian yang dipasang di satu
 * penanda saja adalah pengecualian yang menjaga pintu sambil membuka jendela.
 */
export function buildTurnReminder(prompt: string): string | null {
  // Sinyalnya harus menyebut plugin INI, bukan sekadar "ada channel": satu sesi
  // bisa punya plugin ini DAN plugin telegram lama tersambung sekaligus.
  //
  // `reply-guard` punya dua sinyal, `origin.server` atau regex tag ini. Hook
  // UserPromptSubmit hanya menerima { prompt }, tanpa transcript, jadi hanya
  // yang kedua tersedia di sini. Konsekuensinya: prompt yang cuma MENYEBUT tag
  // itu ikut menyalakannya. Diterima sadar -- hook ini tidak memblokir apa pun,
  // jadi harganya satu baris, bukan giliran yang mati.
  if (!new RegExp(`<channel[^>]*source="[^"]*${PLUGIN_ID}`).test(prompt)) return null;

  // Giliran antar-bot tidak boleh dijawab dengan `reply` sama sekali (aturan
  // `inter-bot-channel`), jadi mengingatkan soal tombol di sana adalah
  // menyuruh melakukan hal yang aturan lain melarang.
  if (prompt.includes(AGENT_TURN_MARKER)) return null;

  // Menyebut TOOL dan PARAMETERnya, bukan cuma tindakannya. Pelajaran
  // `name-session`: pengingat yang menyuruh sebuah tindakan tanpa menyebut
  // alatnya membuat bot uji membaca source code repo sebelum menemukan
  // tool-nya. "AI pasti tahu caranya" adalah asumsi yang sudah terbukti salah
  // sekali di repo ini.
  return (
    `Rule \`${RULE_BUTTONS_WHEN_PICKABLE}\` for THIS turn: if the answer you want can be picked ` +
    `from a short list -- a confirmation, or a menu of 2-4 named options -- attach the ` +
    `\`buttons\` parameter to your \`reply\` call. For a menu, write the options out as a numbered ` +
    `list in the body and let the buttons be bare numbers (\`1\`, \`2\`, ...), with a ✅ marking ` +
    `your recommended option on its line in the BODY, never on the button; a plain yes/no ` +
    `confirmation may use two short labels instead. If its real answer is prose, send it without ` +
    `buttons. The engine appends the escape hatch itself; never write that one yourself.`
  );
}

function main(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  let prompt = "";
  try {
    // BOM dibuang dengan cara yang sama seperti `parseHookInput` di
    // reply-guard: satu byte tak terlihat di depan sudah cukup membuat
    // JSON.parse gagal, dan hook yang gagal parse adalah hook yang mati bisu.
    prompt = JSON.parse(raw.replace(/^﻿/, ""))?.prompt ?? "";
  } catch {
    return;
  }
  if (typeof prompt !== "string") return;

  const reminder = buildTurnReminder(prompt);
  if (reminder === null) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: reminder,
      },
    })
  );
}

if (import.meta.main) main();
