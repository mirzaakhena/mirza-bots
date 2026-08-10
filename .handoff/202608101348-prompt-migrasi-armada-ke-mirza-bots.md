# Migrasi Armada bot-01..bot-06 Ke `mirza-bots`

**Date:** 2026-08-10 13:48 (WIB)
**Repo kerja:** C:\Users\Mirza\workspace\mirza-bots
**Branch:** main (HEAD: 5fd8614)
**Dari → Ke:** bot-02 → —
**Pair:** —
**Lanjutan dari:** —
**Plan terkait:** `docs/2026-08-10-migrasi-bot-06-spec.md` — spec migrasi, §10 memuat bagian armada

---

## 1. Tujuan Handoff

Diminta user: *"Tulis handoff saja."* Mode **📄 File only** — tidak ada estafet
ke bot mana pun, tidak ada self-reset.

Alasan strukturalnya bukan sekadar permintaan: **bot terakhir yang belum pindah
adalah `bot-02`, yaitu session yang menulis dokumen ini.** Menutupnya mengakhiri
satu-satunya konteks yang memegang seluruh pekerjaan ini. Berkas ini yang
menggantikannya.

**Goal estafet:** memindahkan `bot-02` ke sistem `mirza-bots` (bot terakhir dari
enam), lalu membuktikan tiga fitur yang sampai sekarang **belum pernah dilihat
menyala oleh siapa pun**.

## 2. Konteks Proyek

`mirza-bots` menjadikan sebuah folder Claude Code bisa dihubungi dari Telegram.
Dua paket: `cc-plugin` (engine, Bun, hidup di dalam proses tiap sesi CC) dan
`cc-wrapper` (Node + `tsx`, membungkus CC di PTY supaya slash bisa disuntik dari
luar). Tanpa daemon, tanpa state bersama — **sebuah folder adalah bot bila ia
memuat `config.json`**, dan nama bot = nama folder.

Repo ini menggantikan sistem lama `mirza-marketplace/plugins/telegram`, yang
sampai hari ini melayani enam bot harian. Migrasi ini yang memindahkan keenamnya.

## 3. Yang Sudah Selesai (SUDAH)

**Lima dari enam bot sudah pindah dan terverifikasi lewat `doctor`:**

| bot | arsip | `doctor` |
|---|---|---|
| bot-06 | `_arsip-migrasi-2026-08-10T10-24-49/` | `ok`, engine hidup, `status.json` ADA |
| bot-03 | `_arsip-migrasi-2026-08-10T11-19-42/` | `ok`, engine hidup, `status.json` ADA |
| bot-04 | `_arsip-migrasi-2026-08-10T11-28-20/` | `ok`, engine hidup, `status.json` ADA |
| bot-05 | `_arsip-migrasi-2026-08-10T13-28-44/` | `ok`, engine hidup, `status.json` ADA |
| bot-01 | `_arsip-migrasi-2026-08-10T13-38-21/` (117 item) | `ok`, `pid: null` — **belum dinyalakan** |

Semuanya diverifikasi ulang: token di `config.json` **identik byte-per-byte**
dengan yang di arsip (`-ceq`, case-sensitive).

**Commit sesi ini (`f6240b5..5fd8614`, semuanya sudah di-push):**

- `2b3d5a8` spec migrasi bot-06 — merged, di `main`
- `197c420` koreksi path arsip + batas klaim
- `1fbbc29` **`cc-plugin` 0.42.0** — perbaikan scope menu Telegram (kode + 6 test)
- `01cadcf` `scripts/migrasi-dari-marketplace.ps1` + §10 spec
- `a39e175` temuan "nyalakan DUA kali"
- `5fd8614` `scripts/` masuk peta berkas README

⚠️ `bb5eb47` **bukan milik sesi ini** — itu handoff bot lain (sisa temuan review
kelompok A). Kami berbagi satu working tree; lihat §9.

**Terverifikasi HIDUP hari ini** (bukan test hijau — diukur lewat API Telegram):
perbaikan scope menu, pada **dua** bot berbeda. bot-03 dan bot-05 keduanya
bergerak dari `chat 10 + all_private_chats 2 + default 0` menjadi
`0 + 0 + default 5`, dikerjakan engine sendiri saat lahir, tanpa sentuhan manual.

## 4. Yang Sedang Dikerjakan (SEDANG)

Tidak ada berkas setengah diedit; working tree bersih dan sudah di-push.

Yang menggantung adalah **keadaan dunia, bukan kode**:

- **`bot-01` sudah dimigrasi tapi belum dinyalakan** (`doctor` → `pid: null`).
  User perlu menjalankan `mirza-bot` **dua kali** di foldernya.
- **`bot-02` belum dimigrasi sama sekali.** Sesi lamanya masih hidup — itu sesi
  yang menulis berkas ini.

## 5. Blocker

**Satu, dan sifatnya struktural, bukan teknis.**

`bot-02` tidak bisa dimigrasi dari dalam sesinya sendiri. Sesi yang hidup
memegang handle `messages.db`, dan Windows menolak memindahkan berkas yang
handle-nya dipegang proses lain — terukur:

```
bot-01 : messages.db TERKUNCI proses lain -- Move-Item akan GAGAL
bot-02 : messages.db TERKUNCI proses lain -- Move-Item akan GAGAL
bot-05 : messages.db TERKUNCI proses lain -- Move-Item akan GAGAL
```

Alasan kedua yang lebih halus: sesi lama memegang token di **memori**, jadi ia
terus menarik pesan walau `.env`-nya sudah dipindah. Menyalakan engine baru
sebelum sesi lama mati menghasilkan dua poller satu token — Telegram membagi
pesan secara **acak**, tanpa galat apa pun.

**Yang membukanya:** user menutup sesi `bot-02`, lalu menjalankan skrip sendiri.
Bukan sesuatu yang bot mana pun bisa kerjakan untuknya — dan itu justru kenapa
skripnya ada.

## 6. Yang Akan Dikerjakan (AKAN)

**Goal:** `bot-02` pindah ke `mirza-bots`, lalu tiga fitur yang belum pernah
menyala dibuktikan hidup.

**Langkah, milik USER (bukan bot):**

1. Nyalakan `bot-01` dua kali: `cd C:\Users\Mirza\workspace\bot-01` → `mirza-bot`
   → tutup → `mirza-bot`.
2. Tutup sesi `bot-02`.
3. `powershell -File C:\Users\Mirza\workspace\mirza-bots\scripts\migrasi-dari-marketplace.ps1 -Bot bot-02`
   (dry-run, tidak menyentuh apa pun)
4. Ulangi dengan `-Apply`.
5. `cd C:\Users\Mirza\workspace\bot-02` → `mirza-bot` → tutup → `mirza-bot`.

**Langkah, milik bot berikutnya** — membuktikan tiga yang belum pernah terlihat
menyala (`celah-migrasi-hitung-ulang` §5 menyatakannya eksplisit):

| Yang dibuktikan | Cara | Frekuensi di sistem lama |
|---|---|---|
| **Typing indicator** | balasan yang butuh >5 detik | 36,7×/hari |
| **Chunking >4096** | balasan panjang yang memuat blok kode berpagar | 10,6×/hari |
| **Lampiran keluar** | `reply` dengan `files` berisi satu gambar | 2,7×/hari |

Chunking wajib memuat blok kode: penjahitan ulang fence ``` adalah bagian yang
paling gampang meleset, dan `balanceFences()` belum pernah diuji di Telegram
sungguhan.

**Starting point:** `main` (HEAD `5fd8614`); baca
`docs/2026-08-10-migrasi-bot-06-spec.md` — §4 urutan langkah, §5 dua pagar yang
menentukan, §10 bagian armada.

## 7. Referensi

| Referensi | Kapan dibaca |
|---|---|
| `~/.claude/agent-playbook/PLAYBOOK.md` | Di awal, sebelum kerja substantif |
| `docs/2026-08-10-migrasi-bot-06-spec.md` | Di awal — source of truth migrasi; §10 memuat armada |
| `README.md` (root) | Di awal — arsitektur, empat keputusan, urutan rilis plugin |
| `../mirza-marketplace/docs/2026-07-26-rebuild-audit/2026-08-05-celah-migrasi-hitung-ulang.md` | Saat butuh angka pemakaian per bot atau daftar celah yang masih terbuka |
| `../mirza-marketplace/docs/2026-08-08-komparasi-marketplace-vs-mirza-bots.md` | Saat user bertanya "fitur X ke mana?" |
| `.handoff/202608101141-prompt-sisa-temuan-review-mirza-bots.md` | HANYA saat mengerjakan temuan review kelompok A/B/C — handoff bot LAIN, bukan lanjutan berkas ini |

## 8. Keputusan User Lewat Brainstorming

| Pertanyaan | Pilihan User | Konsekuensi |
|---|---|---|
| Lapisan behavioral skill mana yang hidup di bot yang dipindah? | **Ikut `mirza_01_bot`/`mirza_02_bot` persis** | 8 plugin lama `false`. Buktinya bukan selera: `inline-buttons/SKILL.md` menyebut skema tombol lama (`{label, callback_id}`) **33×** sementara tool `reply` baru menuntut `{text, data}` — skill itu akan aktif mengajarkan bentuk yang ditolak. Konfigurasi identik dengan dua bot yang sudah bekerja berarti gejala aneh tidak bisa disebabkan skill lama. |
| Versi `cc-plugin` untuk bot yang dipindah? | **Update ke 0.41.0 dulu** | `/branch` + `/switch` hanya ada di ≥0.41.0. Risiko ke dua bot yang sedang jalan diperiksa dan **nol**: cache tidak pernah dipangkas (37 versi utuh) dan `isOurBridge` (`chain.ts:55`) mengenali bridge lepas dari nomor versi → path mereka self-heal via `stale-bridge`. |
| Scope menu Telegram yang tertinggal — ditangani di mana? | **Perbaiki di `cc-plugin`** | Lahir 0.42.0. Alternatif "cukup langkah manual per bot" ditolak karena bergantung pada orang yang mengingatnya lima kali lagi, dan kegagalannya tidak berbunyi. |
| `/context` menunggu tanpa batas sesudah migrasi pertama | **Tidak diperbaiki di kode, cukup dicatat** | Restart sekali per bot memang murah. ⚠️ Tapi bentuk kegagalannya bertentangan dengan doktrin repo sendiri — lihat §9. |
| Cakupan "bersih dari nol" untuk folder bot | User **menghapus sendiri** berkas kerja bot-06 sebelum migrasi | Yang tersisa persis state sistem lama, jadi tidak ada keputusan yang perlu diambil soal berkas kerja. |
| Urutan armada | Mulai **bot-03**, bukan bot-05 seperti usulan | Usulan awal `05→04→03→01→02`; user memilih mulai dari 03. Urutan akhir yang terjadi: `06, 03, 04, 05, 01`, sisa `02`. |
| Siapa menjalankan `mirza-bot` | **User sendiri** | Bot tidak pernah menyalakan bot. Konsekuensinya langkah update plugin + launch jadi satu perintah user, dan versi yang benar-benar terpasang tercetak di layarnya — bukti yang lebih baik daripada laporan agen. |

## 9. Anti-Patterns / Lessons (CARRY FORWARD)

- ❌ **JANGAN menganggap "daftar sudah didaftarkan" berarti "daftar terlihat".**
  Telegram menyimpan menu per **scope** dan yang lebih spesifik menang
  (`chat` > `all_private_chats` > `default`). `setMyCommands` tanpa `scope`
  menulis ke yang **paling lemah**. Bukti: menu bot-06 tidak berubah sedikit pun
  sesudah migrasi, tanpa satu error di mana pun, karena scope `chat` masih memuat
  10 command lama. **Sisa itu hidup di server Telegram** — tidak ada berkas di
  mesin ini yang memperlihatkannya, jadi mengarsipkan state lama tidak bisa
  menghapusnya.
- ❌ **JANGAN menghapus HANYA scope `chat`.** `all_private_chats` akan naik jadi
  pemenang dan user melihat `/help` + `/start` saja — lebih buruk daripada
  sebelumnya. Bersihkan keduanya.
- ❌ **JANGAN memigrasikan bot yang sesinya masih hidup.** Bukan berisiko — ia
  **gagal di tengah**, dan meninggalkan arsip setengah jadi. Gerbang skrip yang
  memeriksa kunci berkas ada untuk itu; jangan dilewati.
- ❌ **JANGAN menganggap `installBridge` yang sukses berarti `/context` hidup.**
  Claude Code membaca `settings.json` saat sesi **lahir**; engine memasangnya
  **sesudah** itu. `mirza-bot` harus dijalankan **dua kali** pada migrasi pertama.
  ✅ Kalau ini muncul lagi pada orang yang tidak membaca dokumen: perbaiki di
  kode — `/context` sekarang **menunggu tanpa batas dan tanpa petunjuk** padahal
  engine sudah memegang jawabannya (`installBridge` mengembalikan `installed`).
  Itu bertentangan dengan doktrin repo ini sendiri: *"gagal diam-diam adalah
  kegagalan yang paling mahal."*
- ❌ **JANGAN pakai `git add -A` di repo `mirza-bots`.** Hanya ada **satu**
  working tree dan semua bot commit di situ; `-A` bisa menyapu masuk perubahan
  bot lain yang belum di-commit. Terjadi nyaris hari ini (`bb5eb47` muncul di
  antara commit-commit sesi ini). ✅ Pakai path eksplisit.
- ❌ **JANGAN percaya `$pid` di PowerShell.** Ia variabel otomatis read-only;
  menugaskannya gagal diam-diam di dalam loop dan tabel survei jadi mencetak PID
  proses sendiri untuk keenam bot. ✅ Pakai nama lain (`$enginePid`).
- ✅ **Periksa dari sisi berkas, bukan dari laporan.** Setiap klaim "sesi sudah
  ditutup" diverifikasi lewat dua sinyal independen: hilang dari
  `~/.claude/agent-registry.json` **dan** probe kunci berkas. Sekali user menekan
  tombol "sudah kututup" 50 detik sesudah diminta — gerbang yang memeriksa
  sendiri lebih murah daripada percaya.
- ✅ **`settings.local.json` menang atas `settings.json`.** Diperiksa di keenam
  bot; isinya cuma `spinnerTipsEnabled`. Kalau nanti ada yang memuat `statusLine`
  atau `enabledPlugins`, migrasi bisa tertimpa **tanpa suara**.

## 10. Catatan Lain

**Artefak:**
- HEAD anchor: `5fd8614`; commit range sesi: `f6240b5..5fd8614` (6 commit, semua
  ber-trailer `Agent: bot-02`, semua sudah di-push ke `origin/main`).
- Berkas baru: `scripts/migrasi-dari-marketplace.ps1`,
  `docs/2026-08-10-migrasi-bot-06-spec.md`, berkas ini.
- Diubah: `cc-plugin/src/engine/slash/menu.ts` (+`staleMenuScopes`),
  `cc-plugin/src/engine/engine.ts` (wiring pembersihan scope),
  `cc-plugin/test/engine/slash/menu.test.ts` (+5 test),
  `cc-plugin/test/engine/engine.test.ts` (+1 test wiring lewat fake Telegram
  server), `README.md`, `plugin.json` + `package.json` (0.41.0 → 0.42.0).
- `bun test` **719 pass, 0 fail**; `bunx tsc --noEmit` bersih.

**Environment:**
- `cc-plugin@mirza-bots` terpasang **0.42.0** dan itu versi yang benar-benar
  berjalan: `installed_plugins.json` mencatat `lastUpdated 2026-08-10T03:53:24Z`
  (sesudah commit `1fbbc29` pukul 03:46Z), dan `doctor` keempat bot yang sudah
  nyala melaporkan `"version": "0.42.0"`.
- Cache plugin **tidak pernah dipangkas**: 37 versi `cc-plugin` masih utuh di
  `~/.claude/plugins/cache/mirza-bots/cc-plugin/`. Ini yang membuat statusline
  ber-path-versi di bot lain tidak pernah mati.

**Sisa yang belum disentuh sama sekali** (bukan bagian goal ini, dicatat supaya
tidak dicari):
- Tiga sisa mati di `~/.claude/`: `channels/telegram/.env` (token **401
  Unauthorized**, bukan milik bot mana pun yang hidup),
  `mirza-bots/` (state root LAMA sistem baru — `fleet.db`, `config.json` bentuk
  `bots` yang zod `strictObject` sekarang **menolak**), dan
  `agent-registry.json`. Diverifikasi lewat grep: nol jalur kode `cc-plugin`
  membacanya, hanya dua komentar yang menyebut `MIRZA_BOTS_HOME`.
- `edit_message` (dipakai armada 58× seumur hidup), `react`, dan
  voice/video/video_note/sticker/audio yang **diabaikan diam-diam tanpa jejak**.
  Kalau ada keluhan "kok bot-nya diam?", ini kandidat pertama — bukan misteri
  baru.
- Skill `handoff` mati di keenam bot yang dipindah. Berkas handoff tetap terbaca
  (template ini memang mandiri), tapi otomatisasinya — 4 mode tombol,
  designation menular, self-reset satu batch — tidak ada.

**Open question:** `enabledPlugins` lapisan project terbukti mematikan
**skill**-nya, tapi belum pernah diverifikasi apakah ia juga mematikan **MCP
server** plugin lama. Pagar kedua (memindahkan `.env` keluar) ada justru karena
pertanyaan itu belum terjawab.

**Catatan user:** mode berkas-saja diminta eksplisit — *"Tulis handoff saja."*
Tidak ada `agent_send`, tidak ada self-reset, tidak ada cron ACK.
