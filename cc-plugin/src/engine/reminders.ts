/**
 * Pengingat mekanis dari mesin ke AI — isi kanal `[from: system]`.
 *
 * ## Kenapa ini ada, dan kenapa BUKAN di SERVER_INSTRUCTIONS
 *
 * `SERVER_INSTRUCTIONS` memuat aturan yang **selalu** berlaku dan dibaca sekali
 * di awal sesi. Berkas ini memuat keadaan yang **sedang** berlaku, dan dikirim
 * tiap kali kondisinya terpenuhi. Memindahkan yang selalu benar ke sini cuma
 * membuatnya dibayar berkali-kali; membiarkan yang kadang benar di sana membuat
 * ia jadi aturan yang menunggu momen yang mungkin tidak pernah datang — dan
 * pada sesi panjang yang konteksnya dipadatkan, ia bergeser jauh dari perhatian.
 *
 * ## Pemicunya KEADAAN, bukan peristiwa (keputusan user 2026-08-06)
 *
 * Selama kondisinya bertahan, pengingatnya ada. Yang hilang karena itu — dan
 * inilah yang membuat desainnya lebih kecil, bukan lebih besar:
 *
 * - tidak ada flag "sudah pernah diingatkan"
 * - tidak ada aturan "jangan nagih"
 * - tidak ada logika berhenti: begitu kondisinya tidak terpenuhi, pengingatnya
 *   lenyap sendiri
 * - AI tidak perlu mengingat apa pun antar-giliran
 *
 * Efek sampingnya self-healing: giliran yang terlewat masih dibawa giliran
 * berikutnya.
 *
 * ## Mesin TIDAK menyusun prioritas
 *
 * Semua yang terpenuhi dikirim, apa adanya, dalam urutan daftar ini. AI yang
 * menyusun prioritasnya, dan AI boleh mengembalikan keputusannya ke user
 * (keputusan user 2026-08-06). Alasannya bukan kemudahan: prioritas adalah
 * penilaian, penilaian tergantung isi pekerjaan, dan mesin tidak tahu isi
 * pekerjaan. Mesin yang mengurutkan adalah mesin mengambil keputusan yang bukan
 * haknya — kekeliruan yang sama bentuknya dengan penanda yang menamai perilaku.
 *
 * ## Syarat penghuni baru
 *
 * Sebelum menambah entri di sini, jawab satu pertanyaan: **kapan ia TIDAK
 * menyala?** Pengingat yang menyala terus berhenti menjadi sinyal dan menjadi
 * latar belakang — dan yang membunuh kanal ini adalah ambang yang longgar,
 * bukan jumlah penghuninya.
 */
import { SYSTEM_TURN_MARKER } from "../server";
import type { CapturedStatus } from "./context/render";

export interface ReminderContext {
  /** `null` berarti sesi ini belum punya nama sama sekali. */
  sessionName: string | null;
  /** Giliran = pesan MASUK dari user di sesi ini; balasan bot tidak dihitung. */
  turnCount: number;
  /** `false` berarti tangkapan statusline milik sesi LAIN — jangan bertindak. */
  statusFresh: boolean;
  /** Context TERPAKAI dalam token. `null` = tidak diketahui, bukan nol. */
  contextUsed: number | null;
  /**
   * Apakah nama sesi BERUBAH sejak sesi ini lahir.
   *
   * Menggantikan pemeriksaan "sessionName === null", yang uji hidup 2026-08-06
   * buktikan tidak pernah terpenuhi lagi: sesudah `/clear`, sesi baru lahir
   * membawa nama sesi sebelumnya, dan ketiga sumber (judul tab, status.json,
   * transcript) sepakat menyebut nama lama. Tidak ada tempat yang bisa ditanya
   * "sesi ini belum bernama?" -- pertanyaannya sendiri yang harus diganti.
   */
  renamedInThisSession: boolean;
}

export interface Reminder {
  id: string;
  /** Murni: seluruh matriks keputusannya bisa diuji tanpa satu berkas pun. */
  applies: (c: ReminderContext) => boolean;
  text: string;
}

/** Ambang giliran sebelum penamaan mulai ditagih. Ditetapkan user 2026-08-06. */
export const MIN_TURNS_BEFORE_NAMING = 2;

/**
 * Context TERPAKAI (token) yang di atasnya pengingat handoff menyala.
 *
 * Ditetapkan user 2026-08-07 — dan angka ini menjawab pertanyaan yang BERBEDA
 * dari pendahulunya. Alasan lengkapnya di entri `context-low` di bawah.
 */
export const MAX_CONTEXT_USED = 400_000;

export const REMINDERS: Reminder[] = [
  {
    id: "name-session",
    // Tiga syarat, dan yang ketiga yang paling mudah dilupakan: data segar.
    // Tanpa itu pengingat ini bisa menilai sesi yang sudah mati.
    applies: (c) =>
      c.statusFresh && !c.renamedInThisSession && c.turnCount >= MIN_TURNS_BEFORE_NAMING,
    // Kalimat PERINTAH, kata per kata dari user 2026-08-06. Bukan pernyataan
    // keadaan ("sesi ini belum bernama"): kalimat yang cuma menyatakan keadaan
    // akan dikarang maksudnya oleh pembacanya, dan di sini pembacanya AI.
    // Syarat penilaiannya tetap milik AI lewat anak kalimat terakhir.
    // Nama tool ikut disebut sejak 0.27.0, dan itu MEMBALIK keputusan user
    // pagi 2026-08-06 -- atas bukti dari uji hidup sore harinya, bukan atas
    // argumen yang sama diulang.
    //
    // Risikonya sudah dicatat sadar di spec saat keputusan pertama diambil:
    // "kalau uji hidup nanti menunjukkan AI menyala tapi tidak tahu caranya,
    // penyebabnya sudah tertulis dan tidak perlu dicari." Terjadi. Transcript
    // mirza_01_bot sesi c24c1ba5 merekam botnya MEMBACA SOURCE CODE REPO
    // (grep WrapperPayload, renameSync) sebelum menemukan `send_slash` lewat
    // ToolSearch.
    //
    // Pelajarannya lebih luas dari satu kalimat: pengingat yang menyuruh sebuah
    // TINDAKAN harus ikut menyebut ALATnya. Bot uji sengaja telanjang -- tidak
    // ada skill yang mengajarkan caranya -- jadi "AI pasti tahu" adalah asumsi
    // yang tidak berlaku di sini.
    text:
      'segera beri nama session ini dengan send_slash "/rename <nama>" ' +
      "jika context yang dibicarakan sudah jelas",
  },
  {
    id: "context-low",
    // PERTANYAANNYA DIGANTI USER 2026-08-07 -- bukan angkanya yang digeser.
    //
    // Sampai 0.32.0 ambangnya "sisa < 100k" dan ia menjawab: "apakah masih
    // CUKUP RUANG untuk menyerahkan?". Itu diukur, dan ukurannya benar: 30 sesi
    // nyata (transcript Claude Code, 2026-08-06) memberi biaya penyerahan
    // bermedian 17k token, maksimum 29k; 100k = ~6x angka itu, karena saat
    // pengingat menyala bot masih harus MENYELESAIKAN pekerjaan berjalan.
    // Karena biaya menyerahkan tidak ikut membesar saat window membesar,
    // bentuk absolut memang tepat untuk pertanyaan ITU.
    //
    // Yang user jaga ternyata pertanyaan lain: "kapan KUALITAS BERPIKIR mulai
    // turun?" -- "konteks yang membengkak hingga di atas 50% akan menurunkan
    // kualitas jawaban model. Model jadi sering lupa dan enggak nyambung."
    // Dan dua pertanyaan itu selama ini terlihat seperti satu, karena pada
    // window 1M "sisa <100k" ADALAH "90% terpakai" -- persis garis merah user.
    // Angka lama mendarat di tempat yang masuk akal, dan justru karena itu
    // tidak ada yang sadar ambang KEDUA tidak pernah ada.
    //
    // Maka 400k TERPAKAI, dan pengingat ini PINDAH, bukan bertambah: tidak ada
    // lagi "garis merah wajib serahkan". Ia MURNI IMBAUAN -- tidak ada handoff
    // otomatis, keputusannya tetap milik user (keputusan user 2026-08-07).
    //
    // Bentuknya tetap ABSOLUT meski pertanyaan barunya berskala terhadap window
    // (kualitas turun di ~40-50% window). Rekomendasi bot-03 adalah persentase;
    // user memilih absolut, sadar. Untuk armada yang seluruhnya 1M hasilnya
    // identik, dan kodenya tidak perlu tahu ukuran window sama sekali.
    //
    // Harga yang diterima sadar: pengingat ini kini menyala ~6x lebih lama
    // (400k..penuh, bukan 900k..penuh). Syarat masuk berkas ini -- "kapan ia
    // TIDAK menyala?" -- masih terjawab (di bawah 400k), tapi marginnya menipis.
    // Penangkalnya bukan mekanisme baru: AI mengingat penolakan user di dalam
    // sesi itu.
    //
    // `null` TIDAK menyalakannya: pengingat yang berbunyi karena datanya tidak
    // ada akan berbunyi di tiap bot yang statuslinenya belum sempat digambar,
    // yaitu tepat di awal setiap sesi.
    applies: (c) => c.contextUsed !== null && c.contextUsed > MAX_CONTEXT_USED,
    // Kalimatnya WAJIB ikut berubah bersama ambangnya. Teks lama berbunyi
    // "ruang context tinggal sedikit" -- pada 400k terpakai sisanya masih 600k,
    // jadi kalimat itu akan menjadi TIDAK BENAR, dan yang membacanya adalah AI,
    // setiap giliran. Pengingat yang salah bicara mengajarkan hal yang salah.
    text:
      "context terpakai sudah cukup banyak dan kualitas berpikir mulai menurun -- " +
      "tawarkan ke user apakah pekerjaan ini diserahkan lewat handoff atau ditutup; " +
      "keputusannya milik user, jangan putuskan sendiri",
  },
];

/**
 * Menyusun konteks dari bahan yang sudah ada di disk, dan MENJAGA KESEGARANNYA.
 *
 * `status.json` hanya diperbarui saat statusline digambar ulang. Tepat setelah
 * sebuah sesi baru lahir, berkas itu masih memuat sesi SEBELUMNYA — lengkap
 * dengan namanya. Bertindak atas data itu berarti menilai sesi yang salah, dan
 * kegagalannya tidak terlihat: yang keluar adalah pengingat yang MASUK AKAL,
 * cuma untuk sesi yang keliru.
 *
 * Karena itu nama sesi hanya dipakai bila `session_id` di dalam tangkapan sama
 * dengan sesi yang sedang berjalan. Kalau tidak — atau kalau id sesi sekarang
 * tidak diketahui sama sekali — jawabannya "tidak segar", dan seluruh pengingat
 * yang bergantung padanya diam. Diam, bukan menebak.
 */
export function buildReminderContext(
  captured: CapturedStatus | null,
  currentSessionId: string | undefined,
  turnCount: number,
  /**
   * Nama yang tercatat saat `session_id` ini pertama terlihat, atau `null` bila
   * belum pernah tercatat. String KOSONG adalah nilai yang sah — itu sesi yang
   * benar-benar lahir tanpa nama, dan harus bisa dibedakan dari "belum tahu".
   */
  firstNameOfSession: string | null = null
): ReminderContext {
  const capturedSessionId = captured?.payload?.session_id;
  const fresh =
    typeof currentSessionId === "string" &&
    currentSessionId.length > 0 &&
    capturedSessionId === currentSessionId;

  const name = fresh && typeof captured?.payload?.session_name === "string"
    ? captured.payload.session_name
    : null;

  // Context terpakai ikut digerbangi kesegaran: angka dari sesi lain bukan cuma
  // tidak berguna, ia menyesatkan -- sesi yang baru lahir akan mewarisi
  // "hampir penuh" milik sesi sebelumnya.
  //
  // Sejak 2026-08-07 yang dibaca adalah TERPAKAI, bukan sisa. `context_window_size`
  // tidak lagi dibutuhkan: ambangnya absolut atas jumlah terpakai (lihat
  // `context-low`), jadi ukuran window tidak ikut menentukan.
  const cw = fresh ? captured?.payload?.context_window : undefined;
  const rawUsed = cw?.total_input_tokens;
  const used = typeof rawUsed === "number" ? Math.max(0, rawUsed) : null;

  // Perbandingan nama, bukan pemeriksaan "ada nama atau tidak". Yang penting
  // bukan SIAPA yang me-rename — user dari terminal, bot lewat send_slash, atau
  // siapa pun — melainkan bahwa namanya sudah bergerak sejak sesi ini lahir.
  //
  // `null` (belum tercatat) sengaja dibaca sebagai "belum di-rename": pada
  // pemanggilan pertama sebuah sesi, catatannya baru saja dibuat dan nilainya
  // pasti sama dengan nama sekarang. Menganggapnya "sudah di-rename" akan
  // membuat pengingat ini diam pada sesi yang justru paling membutuhkannya.
  const currentName = fresh ? (captured?.payload?.session_name ?? "") : "";
  const renamed = fresh && firstNameOfSession !== null && currentName !== firstNameOfSession;

  return {
    sessionName: name,
    turnCount,
    statusFresh: fresh,
    contextUsed: used,
    renamedInThisSession: renamed,
  };
}

export function collectReminders(c: ReminderContext, list: Reminder[] = REMINDERS): Reminder[] {
  return list.filter((r) => r.applies(c));
}

/**
 * Blok yang ditempelkan ke push. String kosong berarti tidak ada yang ditempel —
 * bukan blok kosong, karena penanda tanpa isi tetap dibayar tokennya dan
 * mengajari AI bahwa penanda itu kadang tidak berarti apa-apa.
 */
export function renderReminders(rs: Reminder[]): string {
  if (rs.length === 0) return "";
  return [SYSTEM_TURN_MARKER, ...rs.map((r) => r.text)].join("\n");
}
