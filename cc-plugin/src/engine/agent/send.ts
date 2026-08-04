/**
 * Menitipkan satu pesan ke inbox bot tetangga.
 *
 * tmp+rename, bukan tulis langsung: penerima memindai folder ini dengan
 * polling, dan berkas yang tertangkap setengah tertulis akan terbaca sebagai
 * JSON rusak. Pola yang sama sudah dipakai `slash/pending.ts` dan `agent-bus`.
 *
 * ANTREAN OFFLINE IKUT GRATIS, dan itu bukan kebetulan: bot yang mati tidak
 * memindai, pesannya menunggu di folder, dan `ls inbox/` memperlihatkan berapa
 * yang menunggu tanpa query apa pun. Tabel `bot_inbox` yang dibuang hari yang
 * sama melakukan tugas itu dengan sebuah database dan sebuah daemon.
 *
 * Pesan ini TIDAK PERNAH menyentuh Telegram. Yang membuat sesuatu muncul di HP
 * user hanyalah tool `reply` yang menembak chat id-nya.
 *
 * `now` dan `uuid` disuntik supaya isi berkasnya bisa diuji apa adanya.
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { botNameFrom } from "../paths";
import { resolvePeer } from "./peers";
import { validateOutgoing, type AgentMessage } from "./payload";

export type SendResult = { ok: true; id: string; path: string } | { ok: false; error: string };

export function sendToPeer(
  botHome: string,
  to: string,
  msg: { text: string; expects_reply?: boolean; in_reply_to?: string; hop_count?: number },
  now: () => Date,
  uuid: () => string
): SendResult {
  const expects = msg.expects_reply === true;
  const hop = msg.hop_count ?? 0;

  // Validasi SEBELUM menyentuh disk, dan sebelum tujuannya dicari: pesan yang
  // ditolak tidak boleh meninggalkan jejak apa pun di folder tetangga.
  const check = validateOutgoing({
    text: msg.text,
    expects_reply: expects,
    hop_count: hop,
    ...(msg.in_reply_to !== undefined ? { in_reply_to: msg.in_reply_to } : {}),
  });
  if (!check.ok) return { ok: false, error: check.error };

  const peer = resolvePeer(botHome, to);
  if (!peer.ok) return { ok: false, error: peer.error };

  const id = uuid();
  const payload: AgentMessage = {
    id,
    ts: now().toISOString(),
    from: botNameFrom(botHome),
    text: msg.text,
    expects_reply: expects,
    hop_count: hop,
    ...(msg.in_reply_to !== undefined ? { in_reply_to: msg.in_reply_to } : {}),
  };

  // Dibuat kalau belum ada: bot yang belum pernah dinyalakan belum punya
  // inbox/, dan menolak menitip ke situ akan membuang justru pesan yang paling
  // perlu menunggu.
  mkdirSync(peer.inbox, { recursive: true });
  const final = join(peer.inbox, `${id}.json`);
  const tmp = `${final}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, final);

  return { ok: true, id, path: final };
}
