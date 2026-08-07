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
import { formatTokens, type CapturedStatus } from "../context/render";

export interface PeerStatus {
  bot: string;
  /** Dari proses, bukan dari data. Lihat catatan di `summarizePeer`. */
  online: boolean;
  sessionName: string | null;
  /**
   * Dua sesi boleh bernama sama; idnya tidak. Tanpa ini "sesi task-audit"
   * tidak bisa dibedakan dari "sesi task-audit yang lain".
   */
  sessionId: string | null;
  contextUsedPercent: number | null;
  /**
   * Persen saja TIDAK cukup untuk menjawab ambang <100k, dan itu bukan
   * kehati-hatian berlebih: 5% dari 1M menyisakan 950k, 5% dari 200k
   * menyisakan 190k. Menyamakan keduanya persis kekeliruan yang membuat
   * ambang warisan meleset 38x.
   */
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  model: string | null;
  effortLevel: string | null;
  costUsd: number | null;
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
  const cw = p?.context_window;
  // Satu penyaring untuk semua angka: yang bukan angka menjadi `null`, tidak
  // menjadi nol. Nol yang dikarang untuk data yang tidak ada adalah kebohongan
  // yang terlihat meyakinkan -- kekeliruan yang sama dengan kontrak lama
  // "null berarti ~0%", yang dibatalkan pada hari yang sama.
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    bot,
    online: alive,
    sessionName: str(p?.session_name),
    sessionId: str(p?.session_id),
    contextUsedPercent: num(cw?.used_percentage),
    contextUsedTokens: num(cw?.total_input_tokens),
    contextWindowTokens: num(cw?.context_window_size),
    model: str(p?.model?.display_name),
    effortLevel: str(p?.effort?.level),
    costUsd: num(p?.cost?.total_cost_usd),
    capturedAtMs: num(captured?.captured_at_ms),
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
      const named = s.sessionName ? `sesi "${s.sessionName}"` : "sesi tanpa nama";
      // Id sesi menempel pada namanya, bukan jadi potongan sendiri: ia menjawab
      // "yang MANA", bukan fakta terpisah. Delapan hex sudah cukup membedakan.
      bits.push(s.sessionId ? `${named} (${s.sessionId.slice(0, 8)})` : named);
      if (s.contextUsedPercent !== null) {
        const pct = `ctx ${Math.round(s.contextUsedPercent)}%`;
        bits.push(
          s.contextUsedTokens !== null && s.contextWindowTokens !== null
            ? `${pct} (${formatTokens(s.contextUsedTokens)}/${formatTokens(s.contextWindowTokens)})`
            : pct
        );
      }
      if (s.model) bits.push(s.model);
      if (s.effortLevel) bits.push(`effort ${s.effortLevel}`);
      if (s.costUsd !== null) bits.push(`$${s.costUsd.toFixed(2)}`);
      bits.push(`data ${ageOf(s.capturedAtMs, nowMs)} lalu`);
      return `${head} · ${bits.join(" · ")}`;
    })
    .join("\n");
}
