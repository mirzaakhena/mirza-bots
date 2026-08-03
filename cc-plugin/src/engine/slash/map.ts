/**
 * Menerjemahkan slash Telegram jadi payload untuk cc-wrapper. Murni: tidak
 * menulis apa pun.
 *
 * `/new` TIDAK ADA di Claude Code -- ia inovasi lapisan Telegram, dan
 * terjemahannya dua perintah berurutan: /clear lalu /rename. Urutannya bagian
 * dari kontrak, bukan detail: /clear melahirkan sesi baru, dan /rename harus
 * mendarat di sesi itu.
 *
 * `/rename` kebetulan ada di KEDUA dunia. Lapisan ini yang menang, sama seperti
 * di sistem lama -- bedanya di sana itu terjadi diam-diam. Lihat spec §4.1.
 */
import { validateSessionName } from "./session-name";

export type WrapperPayload =
  | { command: string; confirmAfterMs?: number }
  | Array<{ command: string }>;

export type MapResult =
  | { ok: true; payload: WrapperPayload; ack: string }
  | { ok: false; message: string };

export function mapKnown(name: string, arg: string): MapResult {
  if (name === "/rename") {
    const v = validateSessionName(arg);
    if (!v.ok) return { ok: false, message: v.message };
    return {
      ok: true,
      payload: { command: `/rename ${v.name}` },
      ack: `✏️ Ganti nama sesi jadi \`${v.name}\``,
    };
  }

  if (name === "/new") {
    const v = validateSessionName(arg);
    if (!v.ok) return { ok: false, message: v.message };
    return {
      ok: true,
      payload: [{ command: "/clear" }, { command: `/rename ${v.name}` }],
      ack: `🆕 Sesi baru: \`${v.name}\``,
    };
  }

  // Sengaja ditolak dan bukan dilewatkan: kalau sebuah command ada di daftar
  // "dikenal" tapi tidak punya pemetaan di sini, itu bug, dan diam-diam
  // meneruskannya ke CC akan menyembunyikannya.
  return { ok: false, message: `Command "${name}" belum punya pemetaan.` };
}
