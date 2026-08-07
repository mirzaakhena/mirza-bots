/**
 * Nama sesi Claude Code, dibaca dari transcript CC -- bukan dari `status.json`.
 *
 * ## Kenapa bukan status.json
 *
 * `status.json` hanya ditulis saat Claude Code MENGGAMBAR ULANG statusline, dan
 * itu terjadi pada giliran model. `/rename` bukan giliran model: ia mengubah
 * nama di UI CC seketika tanpa memicu gambar ulang, jadi `session_name` di
 * `status.json` tetap memuat nama LAMA sampai giliran berikutnya kebetulan
 * datang.
 *
 * Terukur 2026-08-07 pada `mirza_02_bot`: `/rename coba-notif` jam 07:37:36
 * menulis ke transcript tapi TIDAK ke `status.json`; berkasnya baru menyusul
 * **59 menit** kemudian, 2,7 detik sesudah giliran pertama tiba. Pengumuman
 * "nama sesi berubah" yang menunggu berkas itu ikut telat 59 menit -- benar
 * isinya, tapi datang jauh sesudah user bisa memakainya.
 *
 * Transcript CC mencatat `custom-title` SEKETIKA. Itu meteran yang sudah
 * terbukti paling telak sepanjang proyek ini.
 *
 * ## Kenapa direktorinya diambil dari path yang boleh basi
 *
 * `transcript_path` di `status.json` bisa menunjuk sesi yang sudah lewat. Yang
 * tetap benar adalah DIREKTORInya -- semua sesi satu bot tinggal di folder yang
 * sama. Jadi: ambil direktorinya dari path basi, nama berkasnya dari
 * `session.id` yang selalu segar.
 *
 * ⚠️ Encoding nama folder milik CC sengaja TIDAK ditebak di sini. Wrapper lama
 * menebaknya dan pecah DIAM-DIAM saat CC mengubahnya (lihat komentar header
 * `cc-wrapper/src/startup.ts`). Di sini folder itu tidak dihitung, ia DIBACA
 * dari apa yang CC sendiri laporkan.
 *
 * ## Kenapa tidak ada perbandingan session_id lagi
 *
 * Pemanggil lama menjaga "nama ini milik sesi INI?" dengan membandingkan
 * `captured.payload.session_id` terhadap `session.id`. Di sini identitas sesi
 * dijamin NAMA BERKAS: yang dibuka memang `<session.id>.jsonl`. Guard yang
 * membandingkan dua field bisa menjaga pintu yang benar dan tetap kebobolan
 * lewat jendela; guard yang berupa nama berkas tidak punya jendela.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TITLE_TYPE = "custom-title";

export function readSessionNameFromTranscript(
  transcriptPath: string | undefined,
  sessionId: string
): string | null {
  if (!transcriptPath) return null;

  let raw: string;
  try {
    raw = readFileSync(join(dirname(transcriptPath), `${sessionId}.jsonl`), "utf8");
  } catch {
    // Sesi yang transcriptnya belum ada bukan kerusakan: ia cuma belum menulis
    // apa pun. Yang salah adalah mengarang nama untuknya.
    return null;
  }

  // Dari BELAKANG: yang berlaku adalah `custom-title` terakhir, dan berhenti di
  // sana berarti berkas 200 KB tidak perlu di-parse seluruhnya tiap 5 detik.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    // Saringan murah sebelum JSON.parse. Baris `custom-title` yang sah selalu
    // memuat penanda ini, jadi saringannya tidak bisa membuang yang benar.
    if (line === "" || !line.includes(TITLE_TYPE)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Baris terakhir bisa tertangkap setengah tertulis -- CC masih menulis
      // sambil kita membaca. Satu baris rusak tidak boleh menghapus namanya.
      continue;
    }
    if (
      parsed.type === TITLE_TYPE &&
      parsed.sessionId === sessionId &&
      typeof parsed.customTitle === "string"
    ) {
      return parsed.customTitle;
    }
  }

  return null;
}
