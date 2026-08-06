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
  /** Sisa ruang context dalam token. `null` = tidak diketahui, bukan nol. */
  contextRemaining: number | null;
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
 * Sisa ruang context (token) yang di bawahnya pengingat handoff menyala.
 *
 * DIUKUR, bukan diwarisi — alasan lengkapnya di entri `context-low` di bawah.
 * Ditetapkan user 2026-08-06 sesudah angka ukurnya disodorkan.
 */
export const MIN_CONTEXT_REMAINING = 100_000;

export const REMINDERS: Reminder[] = [
  {
    id: "name-session",
    // Tiga syarat, dan yang ketiga yang paling mudah dilupakan: data segar.
    // Tanpa itu pengingat ini bisa menilai sesi yang sudah mati.
    applies: (c) =>
      c.statusFresh && c.sessionName === null && c.turnCount >= MIN_TURNS_BEFORE_NAMING,
    // Kalimat PERINTAH, kata per kata dari user 2026-08-06. Bukan pernyataan
    // keadaan ("sesi ini belum bernama"): kalimat yang cuma menyatakan keadaan
    // akan dikarang maksudnya oleh pembacanya, dan di sini pembacanya AI.
    // Syarat penilaiannya tetap milik AI lewat anak kalimat terakhir.
    text: "segera beri nama session ini jika context yang dibicarakan sudah jelas",
  },
  {
    id: "context-low",
    // Ambang ABSOLUT, dan itu keputusan yang diambil DARI UKURAN. 30 sesi nyata
    // (transcript Claude Code, 2026-08-06) menunjukkan biaya penyerahan -- dari
    // saat sebuah sesi mulai menulis berkas handoff sampai ia berakhir --
    // bermedian 17k token, maksimum 29k pada kelompok yang benar-benar berhenti
    // sesudahnya. MIN_CONTEXT_REMAINING = ~6x angka itu, karena saat pengingat
    // ini menyala bot masih harus MENYELESAIKAN pekerjaan yang sedang berjalan
    // sebelum menyerahkannya.
    //
    // Kenapa bukan persentase, seperti aturan lama (35% untuk window 1M, 75%
    // untuk 200k): yang dijaga adalah "masih cukup untuk menyelesaikan dan
    // menyerahkan", dan biaya itu TIDAK berubah saat ukuran window berubah.
    // Aturan lama menjawab satu pertanyaan dengan dua sisa yang berjarak 13x --
    // 650k token untuk model 1M, 50k untuk 200k. Ukurannya sendiri menunjukkan
    // yang pertama menyala 38x lebih awal daripada yang dibutuhkan, dan bot-bot
    // itu dalam praktik memang baru menyerahkan di sekitar 504k (median).
    //
    // `null` TIDAK menyalakannya: pengingat yang berbunyi karena datanya tidak
    // ada akan berbunyi di tiap bot yang statuslinenya belum sempat digambar,
    // yaitu tepat di awal setiap sesi.
    applies: (c) => c.contextRemaining !== null && c.contextRemaining < MIN_CONTEXT_REMAINING,
    text:
      "ruang context tinggal sedikit -- rapikan pekerjaan yang sedang berjalan lalu serahkan lewat handoff, " +
      "atau tutup pekerjaannya, sebelum ruangnya habis di tengah jalan",
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
  turnCount: number
): ReminderContext {
  const capturedSessionId = captured?.payload?.session_id;
  const fresh =
    typeof currentSessionId === "string" &&
    currentSessionId.length > 0 &&
    capturedSessionId === currentSessionId;

  const name = fresh && typeof captured?.payload?.session_name === "string"
    ? captured.payload.session_name
    : null;

  // Sisa context ikut digerbangi kesegaran: angka dari sesi lain bukan cuma
  // tidak berguna, ia menyesatkan -- sesi yang baru lahir akan mewarisi
  // "hampir penuh" milik sesi sebelumnya.
  const cw = fresh ? captured?.payload?.context_window : undefined;
  const size = cw?.context_window_size;
  const used = cw?.total_input_tokens;
  const remaining =
    typeof size === "number" && typeof used === "number" ? Math.max(0, size - used) : null;

  return { sessionName: name, turnCount, statusFresh: fresh, contextRemaining: remaining };
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
