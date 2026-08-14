import { readFileSync } from "node:fs";
import { AGENT_ORIGIN } from "./agent/receive";

/**
 * "Giliran yang SEDANG BERJALAN ini dipicu siapa" -- dibaca dari transcript
 * Claude Code, bukan dari ingatan proses.
 *
 * ## Kenapa modul ini ada
 *
 * Versi pertama AB-4 menjawabnya dengan `lastPushOrigin` di engine.ts: "push
 * TERAKHIR yang masuk ke proses ini". Itu bukan pertanyaan yang sama, dan
 * bedanya terukur di produksi (`bot-02`, 2026-08-13):
 *
 *   conversations.db #177  push asli dari bot-04       -> ditandai (benar)
 *   conversations.db #178..#183  laporan sweep sendiri  -> ikut ditandai (salah),
 *                                                          rentang 1,5 jam
 *   conversations.db #184  user bertanya "kenapa kamu kerap menulis dipicu
 *                          oleh bot lain?"; #187 user sudah mengonfirmasi ke
 *                          bot-04 bahwa dia tidak memicu apa pun
 *
 * Transcript sisi Claude Code menyebut pemicu sebenarnya giliran #179:
 * `origin: {"kind":"task-notification"}` (baris 1016 di `80f4927e`) -- sebuah
 * event Monitor. Monitor periodik TIDAK PERNAH lewat `sink.push`, satu-satunya
 * tempat `lastPushOrigin` diperbarui, jadi origin lama selamat sampai ada push
 * berikutnya -- bisa berjam-jam, dan melewati `/clear` sekalipun.
 *
 * Yang salah bukan nilainya, melainkan PERTANYAANNYA. Ingatan proses tidak
 * pernah tahu batas giliran; transcript tahu, karena Claude Code sendiri yang
 * mencatat entri pemicu setiap kali sebuah giliran dimulai.
 *
 * ## Kenapa `origin` yang dipercaya, bukan isi teks
 *
 * `origin` dibubuhkan Claude Code, bukan disimpulkan dari teks. Pelajaran yang
 * sudah dibayar `reply-guard.ts`: prompt yang MENYEBUT tag `<channel ...>` --
 * persis yang terjadi saat orang menanyakan bug ini kepada botnya sendiri --
 * akan lolos sebagai push sungguhan kalau yang diperiksa cuma isi teks.
 *
 * Nama bot pengirim memang tetap dipungut dari atribut tag, karena di situlah
 * satu-satunya tempat ia ada: Claude Code hanya mencatat `kind` dan `server`
 * pada `origin`, sementara `from_bot` ikut di dalam tag yang ia rakit dari
 * `params.meta`. Yang dipungut dari teks cuma NAMA; keputusan "ini antar-bot
 * atau bukan" tetap berdiri di atas `origin` + `origin="agent"` pada tag
 * PEMBUKA, bukan sekadar kemunculan kata di mana saja.
 */
export type TurnOrigin = { kind: "user" } | { kind: "agent"; fromBot: string };

/**
 * Nama server MCP plugin ini di mata Claude Code.
 *
 * Sengaja dicocokkan sebagai POTONGAN, bukan sama persis: satu sesi bisa
 * menyambung beberapa plugin channel sekaligus, dan penanda ini cuma berhak
 * bicara untuk jalurnya sendiri. Salinan disengaja dari `reply-guard.ts` --
 * hook itu hanya boleh mengimpor `node:`, jadi keduanya tidak bisa berbagi
 * satu konstanta.
 */
const PLUGIN_ID = "cc-plugin";

/**
 * Teks yang bisa dibaca dari sebuah entri, apa pun bentuk isinya.
 *
 * Menanggung beban: push datang dengan `content` berupa STRING biasa,
 * sementara giliran assistant dan hasil tool membawanya sebagai ARRAY bagian.
 * Menguji satu bentuk saja membuat modul ini diam-diam tidak melihat apa-apa.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

/**
 * Atribut tag `<channel ...>` PEMBUKA, atau `null` kalau teksnya tidak diawali
 * tag itu.
 *
 * "Diawali" bukan kerewelan: tag yang disebut di tengah kalimat adalah teks
 * yang kebetulan berbentuk sama, bukan amplop yang dirakit Claude Code.
 */
export function channelTagAttrs(text: string): Record<string, string> | null {
  const opening = /^\s*<channel\s([^>]*)>/.exec(text);
  if (opening === null) return null;
  const attrs: Record<string, string> = {};
  for (const m of opening[1]!.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) attrs[m[1]!] = m[2]!;
  return attrs;
}

/**
 * Pemicu giliran terakhir di sebuah transcript, atau `null` kalau tidak ada
 * yang bisa dijadikan jawaban.
 *
 * `null` BUKAN "user". Ia berarti "tidak tahu", dan pemanggil masih punya
 * jawaban cadangan (lihat `currentTurnOrigin` di engine.ts). Menyamakan
 * keduanya akan mengubah transcript yang belum sempat ditulis menjadi
 * pernyataan percaya diri bahwa giliran ini dipicu user.
 *
 * Entri `type:"user"` TANPA `origin` sengaja DILEWATI, tidak dianggap pemicu:
 * hasil tool, sisipan isi skill, dan blok system-reminder semuanya berbentuk
 * begitu, dan jumlahnya jauh melebihi pemicu asli. Menghitung mereka berarti
 * penanda hilang di hampir setiap giliran yang memakai tool.
 *
 * Harga yang dibayar sadar: entri `<command-name>` milik slash command juga
 * datang tanpa `origin`, jadi ia ikut dilewati dan pemicu yang lebih lama masih
 * terbaca. Arahnya dipilih begitu dengan sengaja, sama seperti sejak awal --
 * kelebihan menandai cuma berisik, kekurangan menandai mengembalikan persis
 * masalah yang fitur ini ada untuk menutupnya. Kalau alih-alih dilewati ia
 * dianggap pemicu "user", `send_slash` yang diterbitkan bot saat mengganti nama
 * sesinya sendiri -- yang justru sering terjadi di tengah alur handoff
 * antar-bot -- akan menelan penanda giliran antar-bot yang sah.
 */
export function triggerOfCurrentTurn(lines: string[]): TurnOrigin | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // Satu baris rusak (atau baris terakhir yang belum selesai ditulis) tidak
      // sepadan dengan kehilangan seluruh pembacaan.
      continue;
    }

    if (obj?.type !== "user") continue;
    const kind = obj?.origin?.kind;
    if (typeof kind !== "string") continue;

    // Semua pemicu yang BUKAN channel milik plugin ini -- `human` (diketik di
    // terminal), `task-notification` (monitor periodik, penyebab bug ini), dan
    // apa pun yang Claude Code tambahkan kelak -- jatuh ke "user", yaitu TIDAK
    // menandai. Default itu disengaja: satu-satunya hal yang berhak menandai
    // adalah pesan antar-bot yang benar-benar terbukti, bukan segala sesuatu
    // yang belum dikenali.
    if (kind !== "channel") return { kind: "user" };
    if (!String(obj?.origin?.server ?? "").includes(PLUGIN_ID)) return { kind: "user" };

    const attrs = channelTagAttrs(textOf(obj?.message?.content));
    if (attrs === null || attrs.origin !== AGENT_ORIGIN) return { kind: "user" };
    return { kind: "agent", fromBot: attrs.from_bot ?? "bot lain" };
  }

  return null;
}

/**
 * `triggerOfCurrentTurn` untuk sebuah berkas transcript.
 *
 * Dibaca UTUH, bukan ekornya saja. Satu entri tunggal bisa berukuran megabyte
 * (hasil tool besar, sisipan isi skill), jadi jendela ekor berapa pun punya
 * ukuran masukan yang membuatnya kehilangan pemicu -- dan kehilangannya tidak
 * terlihat, ia cuma memulangkan `null`. Transcript terbesar yang terukur di
 * mesin ini 9 MB, dan ini dibaca sekali per panggilan `reply`, bukan di jalur
 * panas mana pun.
 *
 * Kegagalan apa pun -> `null` ("tidak tahu"), tidak pernah melempar: modul ini
 * duduk di jalur kirim, dan sebuah balasan tidak boleh gagal sampai gara-gara
 * pertanyaan tambahan tentang siapa yang memicunya.
 */
export function readTurnOrigin(transcriptPath: string): TurnOrigin | null {
  try {
    return triggerOfCurrentTurn(readFileSync(transcriptPath, "utf8").split("\n"));
  } catch {
    return null;
  }
}
