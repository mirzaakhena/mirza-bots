/**
 * Status satu bot tetangga: FAKTA saja, tanpa penilaian.
 *
 * Sistem lama menurunkan kesiapan sebuah bot dari prefiks nama sesinya
 * (`idle` = siap, `task-` = sibuk, `done-` = transisi). area-05 §5.4 mencabut
 * itu: nama sesi kembali menjadi label bebas untuk manusia, dan status bukan
 * lagi sesuatu yang bisa dibaca dari sebuah string. Modul ini karena itu
 * SENGAJA tidak mengembalikan `lifecycle` — mengarangnya di sini akan
 * menghidupkan kembali persis yang dicabut, cuma dari tempat baru.
 *
 * Pembagian perannya sama dengan yang berlaku di seluruh sistem baru: mesin
 * menyediakan fakta, AI yang membacanya memutuskan artinya.
 */
import type { CapturedStatus } from "../context/render";

export interface PeerStatus {
  bot: string;
  /** Dari proses, bukan dari data. Lihat catatan di `summarizePeer`. */
  online: boolean;
  sessionName: string | null;
  contextUsedPercent: number | null;
  model: string | null;
  /** `null` berarti bot itu belum pernah menggambar statusline. */
  capturedAtMs: number | null;
}

/**
 * `online` HARUS datang dari prosesnya, bukan dari ada-tidaknya tangkapan.
 *
 * `status.json` tidak ikut hilang saat botnya mati — berkasnya tetap di disk
 * dengan isi terakhirnya. Menyimpulkan "hidup" dari keberadaan data akan
 * melaporkan bot yang sudah mati sebagai bot yang sedang mengerjakan sesi
 * bernama X, dan itu kekeliruan yang terlihat meyakinkan.
 *
 * Arah sebaliknya juga dijaga: bot yang hidup tapi belum pernah menggambar
 * statusline tetap `online`, datanya saja yang kosong. Keduanya keadaan yang
 * berbeda, dan pemanggilnya butuh membedakannya.
 */
export function summarizePeer(
  bot: string,
  captured: CapturedStatus | null,
  alive: boolean
): PeerStatus {
  const p = captured?.payload;
  const pct = p?.context_window?.used_percentage;
  return {
    bot,
    online: alive,
    sessionName: typeof p?.session_name === "string" ? p.session_name : null,
    contextUsedPercent: typeof pct === "number" ? pct : null,
    model: typeof p?.model?.display_name === "string" ? p.model.display_name : null,
    capturedAtMs: typeof captured?.captured_at_ms === "number" ? captured.captured_at_ms : null,
  };
}

/**
 * Isi `bot.pid` menjadi angka yang aman ditanyakan ke sistem, atau `null`.
 *
 * Berkas itu ditulis proses lain dan dibaca di sini apa adanya, jadi bentuk
 * rusaknya bukan hipotesis: `bot.pid` pernah berganti angka di tengah insiden
 * perebutan lock 2026-08-05. Nol dan negatif ikut ditolak karena
 * `process.kill` memperlakukannya sebagai GRUP proses, bukan satu proses --
 * kekeliruan yang tidak akan terlihat sebagai error, hanya sebagai jawaban
 * yang salah.
 */
export function pidFrom(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Umur tangkapan dalam bentuk yang bisa dibaca sekilas. */
function ageOf(capturedAtMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - capturedAtMs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * Umur data ikut ditulis, dan itu bukan hiasan.
 *
 * `status.json` hanya diperbarui saat statusline digambar ulang, jadi ia bisa
 * basi tanpa tanda apa pun — terukur 2026-08-05: ia memuat `uji-batch-1`
 * sementara nama sesi sebenarnya sudah `uji-batch-2`. Pembaca yang tidak
 * diberi tahu umurnya akan memperlakukan angka basi sebagai angka sekarang.
 */
export function renderPeerStatuses(list: PeerStatus[], nowMs: number): string {
  if (list.length === 0) return "Tidak ada bot lain di folder induk.";

  return list
    .map((s) => {
      const head = `${s.bot} — ${s.online ? "online" : "offline"}`;
      if (s.capturedAtMs === null) return `${head} · belum ada data statusline`;

      const bits: string[] = [];
      bits.push(s.sessionName ? `sesi "${s.sessionName}"` : "sesi tanpa nama");
      if (s.contextUsedPercent !== null) bits.push(`ctx ${Math.round(s.contextUsedPercent)}%`);
      if (s.model) bits.push(s.model);
      bits.push(`data ${ageOf(s.capturedAtMs, nowMs)} lalu`);
      return `${head} · ${bits.join(" · ")}`;
    })
    .join("\n");
}
