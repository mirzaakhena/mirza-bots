# Sisa Temuan Review `mirza-bots` — Kelompok A Tuntas, B dan C Menunggu

**Date:** 2026-08-10 11:41 (WIB)
**Repo kerja:** `C:\Users\Mirza\workspace\mirza-bots`
**Branch:** `main` (HEAD `01cadcf`) — ⚠️ HEAD sudah **bergerak melewati** pekerjaan sesi ini, lihat §5
**Dari → Ke:** bot-05 → —
**Pair:** —
**Lanjutan dari:** —
**Plan terkait:** `docs/2026-08-10-review-temuan-perbaikan.md` — **dokumen induk, baca ini dulu**

---

## 1. Tujuan Handoff

Diminta user secara eksplisit (*"Tolong tuliskan handoff file saja"*). **Bukan**
karena context menipis dan **bukan** karena buntu — sesi berhenti di titik
bersih: semua ter-commit, ter-merge, ter-push, pohon kerja bersih, 719 test
hijau.

**Goal estafet:** menuntaskan sisa temuan review yang belum dikerjakan —
**A-4, A-9, seluruh kelompok B (5 beban performa), dan kelompok C (7 risiko
struktur)**.

---

## 2. Konteks Proyek

`mirza-bots` = harness yang menjadikan satu sesi Claude Code bisa dihubungi dari
HP lewat Telegram. Dua paket: **`cc-plugin`** (engine + MCP server, Bun, hidup di
dalam proses sesi CC) dan **`cc-wrapper`** (membungkus CC dalam PTY supaya slash
command bisa disuntik dari luar, Node + `tsx` — bukan Bun, dan itu terukur).

Tidak ada daemon, tidak ada state bersama: **sebuah folder adalah bot bila ia
memuat `config.json`**, dan seluruh statenya tinggal di folder itu.

Doktrin yang membentuk hampir semua keputusannya, dan yang paling sering jadi
alasan sebuah temuan layak diperbaiki: **gagal diam-diam adalah kegagalan yang
paling mahal.**

---

## 3. Yang Sudah Selesai (SUDAH)

Semua ter-commit dan **ter-push** ke `origin/main`. Tidak ada branch atau
worktree menggantung — ketiga branch fitur sudah di-merge `--no-ff` lalu dihapus.

| Commit | Isi | Versi |
|---|---|---|
| `25e3318` | Review menyeluruh (`docs/2026-08-10-review-temuan-perbaikan.md`) + README ditulis ulang | — |
| `28476d4` → `9610c69` | **A-2, A-3, A-10** — pagar jalur `reply` + slash basi | 0.39.0 |
| `5d71d4c` → `ed4c2c6` | **A-1, A-7, A-8** — efek samping yang menulis di tempat orang | 0.40.0 |
| `2e5330e` → `f6240b5` | **A-5, A-6** — siklus hidup engine | 0.41.0 |

### 3.1 Apa yang sebenarnya diperbaiki

Jangan baca ulang diff-nya; catatan **✅ SUDAH DIPERBAIKI** di dokumen review
memuat alasan lengkap tiap perbaikan. Ringkas per temuan:

- **A-2** `findUnsafeButtonData` — `callback_data` >64 **byte** ditolak di
  `prepareReply`, sebelum satu byte pun berangkat.
- **A-3** namespace `slash:` ditutup untuk tombol AI + id sesi wajib UUID.
  Ini yang paling dalam: tombol ber-`data: "slash:go:/clear"` sebelumnya
  disuntik ke Claude Code **tanpa prompt konfirmasi**.
- **A-10** `isStalePayload` — payload `slash/` yang menunggu >10 menit dibuang,
  dan **perintahnya disebut di log**.
- **A-1** `isBotFolder` naik ke baris pertama `runHook`. Hook berhenti membuat
  `logs/` di folder yang bukan bot.
- **A-7** `runDoctor` — config diperiksa dulu, `ensureBotDirs` dicabut habis,
  db yang belum ada dilaporkan `false` bukan dibuat.
- **A-8** `redactTokenInConfig` — token tidak lagi tercetak ke stdout.
- **A-5** `installShutdown` — `Engine.close()` akhirnya benar-benar dipanggil.
- **A-6** `AlbumBuffer.stopAll()` — dipanggil dari `close()` sebelum db ditutup.

### 3.2 Diverifikasi, bukan diasumsikan

- **719 test hijau** di `cc-plugin`, **66** di `cc-wrapper`, `tsc --noEmit`
  bersih di keduanya — dijalankan ulang di HEAD `01cadcf` sesaat sebelum
  handoff ini ditulis.
- **Mutation check** dilakukan pada lima pagar, bukan sekadar dilihat hijau:
  `isBotFolder` di hook, urutan `runDoctor`, penjaga sekali-jalan
  `installShutdown`, `exit` di handler sinyal, dan **kedua** `clearTimeout` di
  `AlbumBuffer.stopAll`.
- **`doctor` dicoba langsung dari kedua jenis folder.** Dari `cc-plugin/`:
  `{"ok": false, …}`, exit 1, dan `ls` sesudahnya tidak menemukan satu folder
  baru pun. Dari `mirza_01_bot`: laporan lengkap.

---

## 4. Yang Sedang Dikerjakan (SEDANG)

—

Pohon kerja bersih. Tidak ada state mid-flight di luar git.

---

## 5. Blocker

**Tidak ada blocker teknis.** Tapi ada **satu hal yang wajib disadari sebelum
menyentuh apa pun**, dan ia bukan hambatan melainkan konteks yang salah kalau
diabaikan:

⚠️ **Repo ini dikerjakan PARALEL oleh `bot-02`, dan HEAD sudah bergerak melewati
seluruh pekerjaan sesi ini.**

Empat commit di atas `f6240b5` bukan milik sesi ini:

| Commit | Milik | Isi |
|---|---|---|
| `2b3d5a8` | bot-02 | Spec migrasi `bot-06` ke sistem baru |
| `197c420` | bot-02 | Langkah 1–4 migrasi dijalankan |
| `1fbbc29` | bot-02 | **0.42.0** — menu Telegram tak terlihat karena *scope* |
| `01cadcf` | bot-02 | `scripts/migrasi-dari-marketplace.ps1` |

Konsekuensi konkret:

1. **Versi sekarang 0.42.0, bukan 0.41.0.** Naikkan dari situ.
2. **`engine.ts` disentuh kedua sesi.** bot-02 menambah pembersihan scope menu
   di dekat `setMyCommands`; sesi ini menambah `albumBuffer.stopAll()` di
   `close()` dan pagar `findUnsafeButtonData` di `prepareReply`. Keduanya sudah
   berdampingan di HEAD tanpa konflik — tapi **`git pull` dulu sebelum apa pun**,
   dan jangan berasumsi HEAD masih di tempat yang handoff ini sebut.
3. **Armada sedang dimigrasikan.** `bot-06` adalah yang pertama dari enam.
   Perubahan `cc-plugin` sekarang **mengenai bot produksi**, tidak lagi cuma dua
   bot uji. Kalibrasi risikonya ikut berubah.

---

## 6. Yang Akan Dikerjakan (AKAN)

**Goal:** menutup sisa temuan review, mengikuti urutan di
`docs/2026-08-10-review-temuan-perbaikan.md` §E — yang tiga teratas sudah
dicoret.

**Starting point:** buka §E dokumen itu. Urutan berikutnya, apa adanya:

### 5 · A-9 + `test`/`typecheck` script + CI — **kerjakan ini dulu**

Ini yang saya rekomendasikan didahulukan, dan alasannya berubah sejak dokumen
ditulis: **armada produksi sudah mulai pindah** (§5). Memasang pagar sebelum
menambah apa pun di atasnya jadi lebih berharga daripada minggu lalu.

- **A-9** `bun test` menembak `api.telegram.org` **sungguhan** — `getMe`,
  `deleteWebhook`, `setMyCommands` menjawab 401, dan satu `ETIMEDOUT` sudah
  pernah muncul. Setel `TELEGRAM_API_ROOT` lewat preload `bun test` supaya tidak
  ada test yang bisa lolos ke jaringan tanpa menyatakannya.
- **`cc-plugin/package.json` tidak punya `test` maupun `typecheck`** padahal
  komentar di seluruh repo menekankan `bun test` tidak memeriksa tipe.
  `cc-wrapper` punya keduanya. Samakan.
- **CI tidak ada sama sekali** (`.github/workflows` kosong). Untuk repo yang
  seluruh doktrinnya berbunyi *"mesin yang menjaga, bukan ingatan"*, ini lubang
  paling mencolok.

### 6 · A-4, C-3, C-5 — tiga bentuk "hilang tanpa jejak"

- **A-4** `commonMarkToMarkdownV2` tanpa `try/catch`. `chunk.ts` sudah memutuskan
  arah yang benar untuk kegagalan sejenis (potongan yang membengkak dikirim
  sebagai teks polos); alasan yang sama berlaku untuk konversi yang **melempar**.
- **C-3** voice/video/sticker/audio/lokasi/poll tidak masuk `conversations.db`
  **sama sekali**. Satu handler `bot.on("message")` terdaftar paling akhir yang
  mencatat `kind: "unsupported"` mengubah "misteri" jadi satu query.
- **C-5** poller yang tuli tidak bisa dibedakan dari yang sehat. Token dicabut →
  bot hidup, tool menjawab, tidak pernah menerima pesan, selamanya. Tulis
  keadaan poller ke berkas dan tampilkan di `doctor`.

### 7 · B-1..B-5 — beban yang tumbuh tiap hari

B-1 `listSessions` membaca **seluruh isi** tiap transcript · B-2 `reply-guard`
mem-parse seluruh transcript **tiap akhir giliran** · B-3 `currentSessionName`
membaca ulang transcript **tiap 5 detik** · B-4 indeks jangkar riwayat tidak
cocok · B-5 `data/`+`logs/` tumbuh tanpa batas dan tanpa laporan.

### 8 · C-1, C-2 — utang struktur

C-1 impor melingkar `server ⇄ engine ⇄ reminders` · C-2 `mirza-bot.cmd`
hard-code path satu mesin. Kerjakan **saat menyentuh berkasnya**, jangan
dijadikan proyek sendiri.

---

## 7. Referensi

| Referensi | Kapan dibaca |
|---|---|
| `docs/2026-08-10-review-temuan-perbaikan.md` (**WAJIB**) | Di awal. Dokumen induk — tiap temuan punya bukti, dan yang sudah selesai punya catatan kenapa perbaikannya berbentuk begitu. |
| `README.md` (**WAJIB kalau belum pernah baca repo ini**) | Di awal. Tujuan, empat keputusan arsitektur, dan seluruh fitur. |
| `docs/2026-08-10-migrasi-bot-06-spec.md` | **Sebelum** menyentuh `cc-plugin`. Ia menjelaskan kenapa perubahan sekarang mengenai bot produksi. |
| `cc-wrapper/PROBE.md` | Hanya kalau menyentuh `cc-wrapper` — ia yang mengukur kenapa Node dan bukan Bun. |
| `docs/2026-08-09-branch-dan-switch-spec.md` | Hanya kalau menyentuh `/branch` atau `/switch`. |
| `docs/2026-08-10-rule-id-dan-pencatatan-pelanggaran-spec.md` | Hanya kalau menyentuh `INSTRUCTION_BLOCKS` atau `reply-guard`. |

---

## 8. Keputusan User Lewat Brainstorming

| Pertanyaan | Pilihan User | Konsekuensi |
|---|---|---|
| Mulai dari temuan mana? | *"kita fix dulu yang bisa meledak sewaktu-waktu"* | A-2/A-3 dulu, lalu A-10 dinaikkan dari urutan 5 ke 2 — pemicunya ternyata cara pakai biasa, bukan skenario eksotis |
| README di-push? | Ditahan dulu, di-review, baru *"push sekarang"* | Rewrite dokumen besar tidak di-push tanpa dilihat manusia |
| Lanjut ke kelompok berikutnya? | *"Lanjut dong"* (dua kali) | A-1/A-7/A-8 lalu A-5/A-6 dikerjakan berurutan tanpa jeda review |
| Handoff sekarang? | *"Tolong tuliskan handoff file saja"* | **Berkas saja** — tidak ada estafet ke bot lain, tidak ada self-reset, sesi ini tidak di-`/clear` |

Satu keputusan **saya** yang membatalkan usul saya sendiri, dan pantas dibawa:
batas jumlah tombol per baris **tidak dipasang** meski saya menulisnya di
dokumen review. Angkanya tidak ada di Bot API — batas 64 byte tertulis resmi,
yang lain cuma saya ingat. Batas yang ditebak menolak balasan yang sebenarnya
sah.

---

## 9. Anti-Patterns / Lessons (CARRY FORWARD)

❌ **Jangan percaya test hijau yang belum pernah dibuktikan bisa merah.** Test
pertama saya untuk `AlbumBuffer.stopAll` hijau dan **tidak berarti apa-apa**:
mencabut `clearTimeout` mana pun tetap hijau, karena `buckets.clear()` sendirian
sudah cukup membuat `flush()` pulang lebih awal. Saya menguji hasil yang benar
lewat jalan yang salah. Perbaikannya: uji lewat **bucket baru dengan kunci yang
sama** — timer basi menembak `flush()` ke bucket itu jauh sebelum waktunya, dan
*itu* bisa dilihat.

✅ **Mutation check itu murah dan repo ini sudah punya doktrinnya** (empat pagar
statusline, `install.ts`). Cabut satu baris guard, jalankan test, pastikan merah,
pulihkan. Tiga puluh detik, dan ia satu-satunya yang membedakan pagar dari
hiasan.

❌ **Jangan memasang batas yang ditebak.** Lihat §8.

✅ **Perbaikan yang menutup satu arah dari masalah dua arah lebih berbahaya
daripada bugnya** — karena komentarnya membuat pembaca berikutnya berhenti
mencari. Sudah terjadi di repo ini (`reply-stored.ts` header). Waspadai bentuk
ini di sisa temuan.

✅ **Pagar sumber (`readFileSync` atas berkasnya sendiri) sudah jadi pola di repo
ini** — `reply-stored.test.ts` dan sekarang pagar `close()`. Batasnya wajib
ditulis: ia menahan **pencabutan**, bukan penambahan.

❌ **Jangan asumsikan HEAD masih di tempat handoff ini menyebutnya.** Repo
dikerjakan paralel; lihat §5.

---

## 10. Catatan Lain

**Artefak.** Commit range sesi ini `e21d6cf..f6240b5` (7 commit, 3 merge).
Berkas baru: `docs/2026-08-10-review-temuan-perbaikan.md`,
`cc-plugin/src/engine/shutdown.ts`, `cc-plugin/test/engine/shutdown.test.ts`.
`README.md` ditulis ulang seluruhnya.

**Yang sengaja TIDAK dikerjakan.** `logs/session-hook.log` yang terlanjur ada di
`bot-01`..`bot-06` **tidak dihapus**. Hook-nya sudah berhenti membuat yang baru
(A-1), tapi membersihkan folder yang bukan urusan perbaikan itu bukan haknya.
Isinya cuma baris `nothing to record`. Catatan: `bot-06` kini **sudah** jadi bot
sungguhan lewat migrasi bot-02, jadi log di sana sekarang sah.

**Yang belum diverifikasi, dan dinyatakan begitu.**

- **C-6** (`send_slash` tidak menolak `/exit`) — saya **belum memastikan** Claude
  Code benar-benar punya `/exit`. Verifikasi dulu sebelum memasang pagarnya.
- **A-3** — saya **belum pernah melihatnya terjadi**. Probabilitasnya rendah; ia
  didahulukan karena kombinasi *diam + merusak + murah ditutup*, bukan karena
  sering.
- **Pagar `albumBuffer.stopAll()` di dalam `close()`** dijaga pagar sumber, bukan
  test integrasi — buffer itu tidak terjangkau dari permukaan `Engine`. Perilaku
  `stopAll` sendiri diuji penuh.

**Environment.** Windows 11, Bun 1.3.11, Node 22 untuk `cc-wrapper`. Test
`cc-plugin` ~13 detik (sebagian karena A-9 — ia menunggu timeout jaringan).

**Open question untuk bot berikutnya.** Sesi ini menghabiskan seluruh kelompok A
kecuali dua. Apakah menuntaskan A-9 + CI lebih dulu (rekomendasi saya, §6) atau
mengikuti urutan dokumen apa adanya — itu **keputusan user**, bukan keputusanmu.
Tanyakan.
