/**
 * Daftar sesi Claude Code milik bot ini. Murni: menerima path, mengembalikan
 * data. Tidak menulis apa pun, tidak menyentuh Telegram.
 *
 * ## Kenapa satu modul, bukan dua
 *
 * `/branch` dan `/switch` sama-sama butuh jawaban atas pertanyaan yang sama:
 * "sesi apa saja yang ada di project ini?". Kalau masing-masing menjawabnya
 * sendiri, dua fitur bisa diam-diam berbeda pendapat -- dan bedanya baru
 * ketahuan saat user melihat sesi di satu tempat tapi tidak di tempat lain.
 *
 * Keduanya memakai irisan yang berbeda dari data yang sama: `/branch` cuma
 * butuh kumpulan `title` (untuk menolak nama yang bentrok), `/switch` butuh
 * semuanya.
 *
 * ## Kenapa direktorinya DILEWATKAN, bukan dihitung
 *
 * Encoding nama folder milik Claude Code (`C--Users-...`) sengaja TIDAK
 * ditebak di sini. Wrapper lama menebaknya dan pecah DIAM-DIAM ketika CC
 * mengubah aturannya -- kelas kegagalan yang paling mahal, karena tidak ada
 * yang terlihat rusak. Pemanggil mengambil direktorinya dari `transcript_path`
 * yang CC sendiri laporkan (lihat `context/session-title.ts` untuk alasan yang
 * sama pada berkasnya).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ForkOrigin = {
  /** Sesi induk tempat percabangan diambil. */
  sessionId: string;
  /** Pesan persis tempat percabangan terjadi -- titik cabangnya, bukan cuma induknya. */
  messageUuid: string;
};

export type SessionInfo = {
  /** UUID sesi, dari nama berkas -- bukan dari isi, supaya tidak bisa berbohong. */
  id: string;
  /** Nama dari `/rename`. `null` berarti sesi ini belum pernah dinamai. */
  title: string | null;
  /** mtime berkas, untuk mengurutkan terbaru dulu. */
  mtime: number;
  /**
   * Asal percabangan, kalau sesi ini lahir dari `/branch`. Field asli Claude
   * Code, terverifikasi ada pada 2026-08-09.
   *
   * Belum dipakai fitur mana pun hari ini, dan itu disengaja: ia gratis saat
   * berkasnya sudah dibaca, dan ia satu-satunya jalan menuju "kembali ke
   * induk" maupun penggambaran pohon yang benar. Membuangnya sekarang berarti
   * membaca ulang seluruh berkas nanti.
   */
  forkedFrom: ForkOrigin | null;
};

/** Nama berkas transcript: UUID diikuti `.jsonl`, bukan sembarang `.jsonl`. */
const TRANSCRIPT_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const TITLE_TYPE = "custom-title";

/**
 * Membaca SATU transcript dan memungut dua hal saja: judul terakhir dan asal
 * percabangannya.
 *
 * Berkas dibaca dari BELAKANG untuk judul (yang berlaku adalah `custom-title`
 * terakhir) tapi dari DEPAN untuk `forkedFrom` (ia ditulis sekali di awal).
 * Baris rusak dilewati, tidak menggagalkan berkas: CC bisa sedang menulis
 * sambil kita membaca, dan satu baris setengah jadi tidak boleh menghapus
 * sebuah sesi dari daftar.
 */
function readOne(dir: string, file: string, id: string): SessionInfo | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, file), "utf8");
  } catch {
    return null;
  }

  let mtime = 0;
  try {
    mtime = statSync(join(dir, file)).mtimeMs;
  } catch {
    /* berkas boleh hilang di antara readdir dan stat -- urutannya saja yang meleset */
  }

  const lines = raw.split("\n");

  let title: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Saringan murah sebelum JSON.parse: berkas ini bisa ratusan KB dan
    // dibaca berulang kali.
    if (!line.includes(TITLE_TYPE)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type === TITLE_TYPE && typeof parsed.customTitle === "string") {
      title = parsed.customTitle;
      break;
    }
  }

  let forkedFrom: ForkOrigin | null = null;
  for (const line of lines) {
    if (!line.includes("forkedFrom")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const f = parsed.forkedFrom as Partial<ForkOrigin> | undefined;
    if (f && typeof f.sessionId === "string" && typeof f.messageUuid === "string") {
      forkedFrom = { sessionId: f.sessionId, messageUuid: f.messageUuid };
      break;
    }
  }

  return { id, title, mtime, forkedFrom };
}

/**
 * Seluruh sesi di sebuah direktori transcript, terbaru dulu.
 *
 * Direktori yang tidak ada dijawab `[]`, bukan lemparan: bot yang belum pernah
 * punya sesi adalah keadaan sah, dan memaksa pemanggil menangkap error untuk
 * keadaan sah selalu berakhir dengan `catch` kosong.
 */
export function listSessions(transcriptDir: string): SessionInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(transcriptDir);
  } catch {
    return [];
  }

  const out: SessionInfo[] = [];
  for (const entry of entries) {
    const m = TRANSCRIPT_NAME.exec(entry);
    if (!m) continue;
    const info = readOne(transcriptDir, entry, m[1]!);
    if (info) out.push(info);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Nama-nama yang sudah dipakai. Dipakai `/branch` untuk menolak nama bentrok.
 *
 * Sesi tanpa nama tidak ikut: "belum dinamai" bukan sebuah nama, dan
 * memasukkannya akan membuat `/branch` menolak nama pertama yang sah.
 */
export function takenTitles(sessions: SessionInfo[]): string[] {
  const names: string[] = [];
  for (const s of sessions) {
    if (s.title !== null && !names.includes(s.title)) names.push(s.title);
  }
  return names;
}
