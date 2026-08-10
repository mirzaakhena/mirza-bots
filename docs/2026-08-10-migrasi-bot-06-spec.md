# Migrasi `bot-06` dari `mirza-marketplace` ke `mirza-bots` — Spec

**Tanggal:** 2026-08-10 · **Penyusun:** bot-02 · **Status:** disetujui user, belum dijalankan
**Bot pertama dari enam.** Urutan armada mengikuti rekomendasi
[`celah-migrasi-hitung-ulang`](../../mirza-marketplace/docs/2026-07-26-rebuild-audit/2026-08-05-celah-migrasi-hitung-ulang.md) §6:
`bot-06` pertama, `bot-01` terakhir.

---

## 0. Keputusan user yang membentuk spec ini

Empat, dan semuanya memotong pekerjaan alih-alih menambahnya:

| Keputusan | Konsekuensi |
|---|---|
| **Tanpa migrasi data, mulai bersih dari nol** (2026-08-05) | `messages.db` (663 KB, 723 pesan) dan `session-names.json` tidak dibawa. Yang dipakai ulang **hanya dua nilai**: token dan chat id. |
| **Token direuse dari bot lama** | Tidak menyentuh BotFather. Konsekuensinya: satu momen di mana dua sistem bisa memegang token yang sama harus dibuat **mustahil**, bukan sekadar dihindari (§5.1). |
| **Lapisan behavioral: ikut `mirza_01_bot`/`mirza_02_bot` persis** | Lima skill dimatikan. Alasannya bukan selera — konfigurasi yang identik dengan dua bot yang sudah bekerja berarti gejala aneh di `bot-06` tidak bisa disebabkan skill lama. Nyalakan satu-satu kalau terasa hilang. |
| **`mirza-bot` dijalankan user sendiri** | Langkah plugin-update + launch jadi satu perintah user (`mirza-bot -u`), dan versi yang benar-benar terpasang tercetak di layarnya. Itu bukti yang lebih baik daripada laporan agen. |

---

## 1. Kenapa migrasi ini kecil — dan kenapa itu bukan kebetulan

Sistem baru **sudah terpasang dan aktif** di mesin ini sebelum spec ini ditulis:
`cc-plugin@mirza-bots` terdaftar user-scope, dan hook `SessionStart`-nya sudah
menyala di `bot-06` tiap sesi. `logs/session-hook.log` membuktikannya:

```
2026-08-10T01:58:10.774Z fired
2026-08-10T01:58:10.775Z no config.json in C:/Users/Mirza/workspace/bot-06 -- nothing to record
```

Sistem baru sudah berdiri di depan pintu `bot-06` berbulan-bulan, dan menolak
mengakuinya sebagai bot karena **satu berkas belum ada**. Itu konsekuensi
langsung keputusan arsitektur #3 (*"sebuah folder adalah bot bila ia memuat
`config.json`"*): migrasi jadi soal menulis plakat nama, bukan memindahkan
barang.

Karena itu spec ini **tidak memuat porting kode**. Nol baris `cc-plugin` atau
`cc-wrapper` berubah.

---

## 2. Keadaan awal `bot-06`, terukur 2026-08-10

Root folder sudah dibersihkan user sebelum spec ini ditulis. Yang tersisa
**persis** state sistem lama:

```
bot-06/
└── .claude/                                   3,27 MB
    ├── settings.json                          statusLine -> context-bridge telegram 0.0.37
    ├── settings.json.backup-*  (5 berkas)     193 byte, isinya identik semua
    ├── scheduled_tasks.lock                   milik Claude Code, bukan sistem lama
    └── channels/
        ├── telegram/
        │   ├── .env                           TOKEN -- satu-satunya salinan di mesin ini
        │   ├── access.json                    allowFrom: ["1121398977"]
        │   ├── chained-statusline              84 byte -> statusline-progress.sh
        │   ├── messages.db                    663 KB · 723 pesan · TIDAK DIBAWA
        │   ├── session-names.json             2,4 KB · TIDAK DIBAWA
        │   ├── last-status.json
        │   └── inbox/                         14 foto lama
        └── pty-controller/
            ├── wrapper.state.json             {"session_name":"idle","lifecycle":"idle"}
            ├── wrapper.log                    102 KB
            └── wrapper.version                {"plugin_version":"0.0.31","wrapper_version":"0.0.8"}
```

**Token hanya hidup di satu tempat.** Semua langkah lain di spec ini bisa
diulang; membaca token tidak. Karena itu ia langkah pertama (§4), bukan langkah
yang kebetulan lebih dulu.

**Kenapa `bot-06` yang pertama** (angka dari `celah-migrasi-hitung-ulang` §6):
723 pesan seumur hidup — sepertiga bot lain — dengan `/switch` 3× dan lampiran
keluar 5×. Ketergantungannya pada celah yang belum ditutup paling kecil, jadi
kalau ada yang meleset kerugiannya paling sedikit.

---

## 3. Bentuk akhir

```
bot-06/
├── config.json          DITULIS TANGAN -- token + allowFrom + timezone
├── .claude/
│   └── settings.json    DITULIS ULANG -- enabledPlugins saja, TANPA statusLine
├── _arsip-migrasi-<ts>/ seluruh channels/ lama + settings.json lama + 5 backup-nya
└── (lahir sendiri saat mirza-bot pertama jalan)
    conversations.db · session.id · status.json · chained-statusline
    bot.pid · wrapper.pid · data/ · inbox/ · slash/ · logs/
```

`config.json`:

```json
{
  "token": "<dari .env lama>",
  "allowFrom": ["1121398977"],
  "timezone": "Asia/Jakarta"
}
```

`.claude/settings.json` — **`statusLine` sengaja tidak ditulis** (§5.2):

```json
{
  "enabledPlugins": {
    "telegram@mirza-marketplace": false,
    "agent-bus@mirza-marketplace": false,
    "pty-controller@mirza-marketplace": false,
    "immediate-reply@mirza-marketplace": false,
    "inline-buttons@mirza-marketplace": false,
    "bot-conduct@mirza-marketplace": false,
    "teach-me@mirza-marketplace": false,
    "handoff@mirza-marketplace": false
  }
}
```

Delapan baris ini **disalin apa adanya** dari `mirza_01_bot/.claude/settings.json`
dan `mirza_02_bot/.claude/settings.json`. Menyalin dan bukan menyusun ulang
adalah bagian dari keputusan user di §0: yang diuji `bot-06`, bukan konfigurasi
baru.

**Nama folder tetap `bot-06`**, jadi nama botnya `bot-06`. Tidak perlu diputuskan
sekarang — di sistem baru memindahkan bot **adalah** rename folder.

`~/.claude/settings.json` **tidak disentuh**. `telegram@mirza-marketplace: true`
di sana yang membuat bot-01..05 tetap jalan; `false` di lapisan project `bot-06`
yang menang secara lokal. Mekanisme ini bukan asumsi — ia sudah bekerja di dua
bot sejak 2026-08-09.

---

## 4. Urutan langkah, dan alasan tiap langkah ada di posisinya

| # | Langkah | Kenapa di sini | Pelaksana |
|---|---|---|---|
| 1 | Baca token dari `.env`, simpan | Satu-satunya salinan. Hilang = minta ulang ke BotFather. | agen |
| 2 | Pindahkan `channels/` + `settings.json` + 5 backup-nya ke `_arsip-migrasi-<ts>/` | **Dipindah, bukan disalin** (§6) | agen |
| 3 | Tulis `.claude/settings.json` baru | Plugin lama mati **sebelum** `config.json` lahir | agen |
| 4 | Tulis `config.json` | Berkas ini yang mengubah folder jadi bot | agen |
| 5 | `mirza-bot -u` dari dalam `bot-06/` | Update plugin **lalu** jalankan bot — satu perintah, urutan benar dijamin launcher | **user** |

**Urutan 3 sebelum 4 adalah pagarnya, bukan preferensi.** Kalau `config.json`
lahir lebih dulu, ada jendela di mana folder ini sah bagi **kedua** sistem: satu
membaca token dari `.env`, satu dari `config.json`, dan keduanya berhak. Menulis
`enabledPlugins` lebih dulu menutup jendela itu sebelum ia ada.

**Urutan plugin-sebelum-restart dijamin `mirza-bot -u` sendiri.** README
`mirza-bots` mencatat kebalikannya sebagai kegagalan yang **tidak meninggalkan
error di mana pun** — yang terlihat cuma slash Telegram berhenti bekerja, karena
`cc-wrapper` baru membaca `slash/` sementara `cc-plugin` lama menulis ke jalur
lama.

---

## 5. Dua pagar yang menentukan, dan bukti keduanya nyata

### 5.1 Dua poller satu token — kegagalan yang tidak berbunyi

Telegram mengizinkan **satu** konsumen `getUpdates` per token. Dua penarik tidak
menghasilkan galat; mereka membagi pesan secara **acak**. Gejalanya terbaca
sebagai *"botnya kadang mendengar"* — dan yang berbahaya bukan kehilangannya,
melainkan bahwa kehilangan **sebagian** tidak terlihat seperti kerusakan.

Plugin lama membaca token dari `.claude/channels/telegram/.env`; yang baru dari
`config.json`. Dua penawar dipasang, bukan satu, karena masing-masing bisa gagal
sendiri:

1. `"telegram@mirza-marketplace": false` di project settings (§3);
2. `.env` **dipindah keluar** dari jalur yang dibaca plugin lama (§6).

Pagar (2) membuat pagar (1) tidak perlu sempurna: seandainya `enabledPlugins`
lapisan project ternyata tidak menutup MCP server plugin lama, tidak ada token
yang bisa ia temukan.

### 5.2 Bridge yang memanggil bridge

`resolveChain` (`cc-plugin/src/engine/context/chain.ts`) mengenali bridge miliknya
**lepas dari nomor versi** — cocokkan `/cc-plugin/` + `/bin/statusline-bridge.ts`
(`isOurBridge`, baris 55). Itu pagar yang ditambahkan 2026-08-04 setelah
perbandingan string persis nyaris membuat bridge lama tersimpan sebagai "rantai".

`bot-06` menabrak sisi lain pagar yang sama. `statusLine` project-nya sekarang
menunjuk
`.../mirza-marketplace/telegram/0.0.37-mirza.0/scripts/context-bridge.ts` — dan
karena `isOurBridge` **sengaja spesifik**, path itu **tidak** dikenali sebagai
bridge. Ia terbaca `kind: "found"` dan akan dijadikan rantai: bridge baru
memanggil bridge telegram lama, yang memanggil `chained-statusline` lama, yang
memanggil statusline user. Tiga hop, dan bridge lama tetap hidup menulis
`last-status.json`.

Bukan rusak, tapi bukan bersih. **Penawarnya: jangan tulis `statusLine` sama
sekali di §3.** `resolveChain` melihat lapisan project kosong, jatuh ke lapisan
user, dan merantai langsung ke `statusline-progress.sh`. Hasilnya identik dengan
`mirza_01_bot`/`mirza_02_bot`, yang `chained-statusline`-nya 84 byte — nilai yang
sama dengan `chained-statusline` telegram lama di `bot-06`.

### 5.3 Risiko update 0.37.0 → 0.41.0 ke dua bot yang sedang jalan: nol

Diperiksa, tidak ditebak:

- Cache plugin **tidak pernah dipangkas** — 37 versi `cc-plugin` masih utuh di
  `~/.claude/plugins/cache/mirza-bots/cc-plugin/`, dari 0.3.0 sampai 0.41.0.
  Path `0.37.0` yang di-pin di `statusLine` `mirza_01_bot`/`mirza_02_bot` tetap
  ada sesudah update.
- 0.41.0 **sudah lengkap di cache** (`node_modules`, `bin/statusline-bridge.ts`,
  `.in_use` diklaim PID 59772 pukul 09:26). `installed_plugins.json` masih
  mencatat 0.37.0, jadi `mirza-bot -u` hanya memindahkan penunjuknya — bukan
  mengunduh 5,6 detik dari GitHub.
- Saat sesi kedua bot itu lahir di 0.41.0, `isOurBridge` mengenali path 0.37.0
  mereka → `stale-bridge` → **path diperbarui, rantai tidak disentuh**.
  Self-healing, dan pagarnya sudah ada di `install.ts:128`.

**0.41.0 bukan kemewahan untuk `bot-06`:** `/branch` dan `/switch` baru ada di
sana. Di 0.37.0, `bot-06` lahir tanpa keduanya.

---

## 6. Backup dan rollback

`channels/`, `settings.json`, dan kelima `settings.json.backup-*` **dipindah**
ke `bot-06/_arsip-migrasi-<ts>/` — mengikuti pola `_arsip-reset-*` yang sudah
dipakai di kedua bot baru.

**Dipindah dan bukan disalin, dan itu bagian dari §5.1.** Tujuannya bukan sekadar
punya cadangan; tujuannya memastikan tidak ada berkas sistem lama yang masih di
jalur yang dibacanya. Salinan meninggalkan aslinya di tempat, dan aslinya itu
yang bisa menghidupkan poller kedua.

`channels/` dipindah **utuh**, bukan dibongkar per berkas — rollback jadi satu
`Move-Item` dan bukan rekonstruksi. Token karena itu berakhir tersimpan **dua
kali**: di `config.json` (tempat kerjanya) dan utuh di
`_arsip-migrasi-<ts>/channels/telegram/.env`.

**Rollback, tiga langkah:** hapus `config.json` → pindahkan balik `channels/` dan
`settings.json` dari arsip → jalankan `mirza-cc`. Karena tokennya tidak pernah
berubah, `bot-06` lama hidup lagi dengan `messages.db` dan `session-names.json`
persis seperti sebelum migrasi.

Satu-satunya yang tidak bisa dikembalikan: pesan yang masuk **selama** percobaan
tercatat di `conversations.db` baru, bukan di `messages.db` lama. Itu lubang di
riwayat lama, dan karena §0 memang tidak membawa riwayat, harganya nol.

---

## 7. Rencana pembuktian

`celah-migrasi-hitung-ulang` §5 menyatakan tiga fitur punya kode dan test **tapi
belum pernah dilihat jalan di Telegram sungguhan**. `bot-06` adalah kesempatan
pertama membuktikannya — itu yang membuat daftar ini bukan formalitas.

| Yang dibuktikan | Cara | Kenapa ini yang dipilih |
|---|---|---|
| Token tidak terbagi | 5 pesan berurutan, **semua** harus sampai | Gejala dua poller adalah kehilangan sebagian; satu pesan tidak membuktikan apa pun |
| **Typing indicator** | pesan yang butuh >5 detik | 36,7×/hari di sistem lama — paling sering muncul, belum terbukti hidup |
| **Chunking** | balasan >4096 karakter yang memuat blok kode | 10,6×/hari; penjahitan fence ``` bagian yang paling gampang meleset |
| **Lampiran keluar** | `reply` dengan `files` berisi satu gambar | 2,7×/hari, belum terbukti hidup |
| Statusline masih milik user | `chained-statusline` berisi `statusline-progress.sh` **dan** baris status di TUI tetap tergambar | Kegagalan ini bertahan di **enam dari enam** bot sistem lama tanpa satu pun error |
| `/context` + `/branch` | dari HP | `/branch` hanya ada di 0.41.0 — sekalian membuktikan versi yang jalan |
| Antar-bot | `agent_send` ke `mirza_01_bot`, `inbox/` terkuras | satu-satunya jalur yang menyentuh folder tetangga |

Plus `bun run doctor` yang harus menjawab
`{"ok": true, "bot": "bot-06", "version": "0.41.0"}` dengan `lock.alive: true`.

---

## 8. Yang `bot-06` kehilangan — dinyatakan supaya tidak jadi misteri

**Dari mesin:** `edit_message` (dipakai `bot-06` 7× seumur hidup), `react`, dan
voice/video/video_note/sticker/audio yang **diabaikan diam-diam tanpa jejak**.
Kalau `bot-06` terasa "diam", ini kandidat pertama yang diperiksa — bukan
misteri baru. Permission relay dan grup Telegram hilang karena arsitektur
(`--dangerously-skip-permissions`; chat id grup selalu negatif), bukan karena
belum sempat.

**Dari lapisan behavioral:** lima skill mati, dan satu menyentuh hal yang user
sendiri pernah tegaskan.

`inline-buttons` mati berarti tidak ada lagi yang **mengingatkan AI menawarkan
tombol**. Mesin sistem baru memang menolak label angka telanjang tanpa narasi
bernomor (`findMissingButtonNarration`) — tapi itu menegakkan **bentuknya**,
bukan **kebiasaan menawarkannya**. Keduanya beda, dan yang hilang justru yang
kedua.

Menyalakan ulang skill itu bukan penawar: SKILL.md-nya menyebut skema tombol lama
(`{label, callback_id}`) **33 kali**, sementara tool `reply` baru menuntut
`{text, data}` — ia akan aktif mengajarkan bentuk yang ditolak. Penawar yang
benar adalah memindahkan aturannya ke sistem baru, dan itu di luar cakupan spec
ini.

`handoff` juga mati. Untuk `bot-06` sendirian ini tidak menggigit; ia menggigit
saat `bot-06` diminta ikut estafet.

---

## 9. Batas klaim

- **Langkah 1–4 sudah dijalankan** 2026-08-10 10:24 WIB; arsipnya
  `_arsip-migrasi-2026-08-10T10-24-49/` (39 item). Token di `config.json`
  diperiksa **identik byte-per-byte** dengan yang di arsip, dan `bun run doctor`
  menjawab `{"ok": true, "bot": "bot-06", "version": "0.41.0"}` dengan
  `lock.pid: null` — config lolos schema zod, belum ada sesi yang memegangnya.
- **Langkah 5 (`mirza-bot -u`) belum dijalankan**, jadi seluruh §7 masih
  rencana. Tidak satu pun dari tujuh baris itu terbukti.
- `enabledPlugins` lapisan project terbukti bekerja di `mirza_01_bot`/`mirza_02_bot`,
  tapi **belum diverifikasi apakah ia juga mematikan MCP server** plugin lama
  atau hanya skill-nya. §5.1 pagar (2) ada justru karena pertanyaan itu belum
  terjawab.
- Cakupan spec ini **satu bot**. Lima bot lain tidak ikut, dan urutan
  berikutnya tetap hak user.

---

## 10. Kelima bot sisanya — apa yang berubah dari `bot-06`

Ditambahkan 2026-08-10 sesudah user meminta migrasi lima bot lain, **termasuk
`bot-02`**, sesi yang menulis dokumen ini.

### 10.1 Armada, terukur

| bot | token | Telegram | sesi lama hidup? |
|---|---|---|---|
| bot-01 | `8674860971` | `@mirza_botone_bot` | ✅ |
| bot-02 | `8745792917` | `@mirza_bottwo_bot` | ✅ **sesi ini sendiri** |
| bot-03 | `8926694543` | `@mirza_botthree_bot` | ✅ |
| bot-04 | `8805996311` | `@mirza_botfour_bot` | ✅ |
| bot-05 | `8777548282` | `@mirza_botfive_bot` | ✅ |

Kelima token **berbeda dan sah** (`getMe` menjawab untuk semuanya), jadi tidak
ada bot yang berebut token bot lain. Yang berebut hanya bisa terjadi dalam satu
folder yang sama.

### 10.2 Yang `bot-06` TIDAK ajarkan: sesi lama yang masih hidup

`bot-06` mudah karena sesi lamanya **sudah tertutup** — ia bahkan tidak lagi
terdaftar di `~/.claude/agent-registry.json`, sementara kelima bot lain punya
heartbeat segar. Konsekuensinya baru terlihat saat diukur:

```
bot-01 : messages.db TERKUNCI proses lain -- Move-Item akan GAGAL
bot-02 : messages.db TERKUNCI proses lain -- Move-Item akan GAGAL
bot-05 : messages.db TERKUNCI proses lain -- Move-Item akan GAGAL
```

Windows menolak memindahkan berkas yang handle-nya dipegang proses lain. Jadi
migrasi bot bersesi hidup bukan "berisiko" — ia **gagal di tengah**, dan
kegagalan di tengah meninggalkan arsip setengah jadi: keadaan yang lebih buruk
daripada tidak mulai sama sekali.

**Urutan per bot karena itu wajib:** tutup sesi lama → migrasikan berkas →
`mirza-bot -u`. Langkah pertama dan ketiga milik user; hanya yang kedua bisa
diotomatiskan.

Ada juga alasan kedua yang lebih halus untuk menutup dulu: sesi lama memegang
token di **memori**. Ia terus menarik pesan walau `.env`-nya sudah dipindah, jadi
menyalakan engine baru sebelum sesi lama mati menghasilkan persis dua poller satu
token yang §5.1 dirancang untuk mencegah.

### 10.3 `scripts/migrasi-dari-marketplace.ps1`

Langkah 1–4 dijadikan skrip, dan itu **bukan kenyamanan**: saat sesi `bot-02`
ditutup, agen yang menulis dokumen ini tidak ada lagi untuk mengerjakannya
manual. Skrip ini yang membuat bot terakhir tetap bisa dipindah.

- **dry-run default**, `-Apply` untuk mengerjakan (mengikuti
  `cc-plugin/scripts/migrate-per-folder.ts`)
- **menolak** kalau ada satu saja berkas di `.claude/channels/` terkunci, dan
  **menyebut berkasnya**
- **menolak** kalau `config.json` sudah ada (jalan dua kali akan mengarsipkan
  state sistem BARU seolah ia milik yang lama)
- `allowFrom` dibaca dari `access.json` bot itu, tidak diketik ulang
- memeriksa ulang sesudah menulis: token di `config.json` harus **identik
  byte-per-byte** dengan yang di arsip, dan `settings.json` harus JSON sah
- memperingatkan (bukan memblokir) kalau `cc-plugin` terpasang < 0.42.0

Terverifikasi 2026-08-10 pada tiga jalur: ditolak pada `bot-05` hidup (menyebut
ketiga berkas `messages.db*`), berhasil pada bot sintetis di scratchpad, dan
ditolak saat dijalankan ulang.

**Tidak ada test otomatis untuk skrip ini, dan itu dinyatakan.** Pengamannya
bukan test melainkan dry-run sebagai default plus gerbang yang menolak sebelum
apa pun bergerak.

### 10.4 Langkah kelima yang tidak ada di §4: **nyalakan DUA kali**

Ditemukan 2026-08-10 dari laporan user: *"bot-04 dan bot-03 kesulitan mereturn
/context"*. Bukti, dan kontrasnya yang menentukan:

```
bot-03  statusLine terpasang · chained-statusline ADA · status.json TIDAK ADA
bot-04  statusLine terpasang · chained-statusline ADA · status.json TIDAK ADA
bot-06  statusLine terpasang · chained-statusline ADA · status.json ADA
```

Bedanya `bot-06` sudah dinyalakan **dua kali** (10:28, lalu 10:53); `bot-03` dan
`bot-04` baru sekali.

**Sebabnya urutan pembacaan, bukan kesalahan `installBridge`.** Claude Code
membaca `settings.json` **saat sesi lahir**. Engine memasang `statusLine` ke situ
**sesudah** sesi lahir — jadi sesi yang sedang jalan tidak pernah memuatnya, tidak
ada yang memanggil bridge, `status.json` tidak pernah lahir, dan `/context`
menunggu berkas yang **secara struktural tidak mungkin muncul di sesi itu**.

Ini kambuhan §5.2 dari arah lain: di sana bahayanya rantai yang salah, di sini
rantai yang benar tapi belum dimuat. Keduanya lahir dari fakta yang sama —
`statusLine` project ditulis oleh engine, dibaca oleh Claude Code, dan keduanya
tidak pernah bertemu dalam satu sesi yang sama saat pemasangan pertama.

**Langkah 5 karena itu berbunyi: jalankan `mirza-bot` DUA kali** pada migrasi
pertama sebuah bot. Biaya sekali per bot, bukan tiap hari.

**Keputusan user 2026-08-10: tidak diperbaiki di kode**, cukup dicatat. Perbaikan
yang dipertimbangkan lalu ditolak: `/context` menjawab *"bridge baru dipasang,
sesi ini belum memuatnya"* ketika `installBridge` mengembalikan `installed`.
Alasannya restart sekali memang murah. ⚠️ Tapi catat bentuk kegagalannya, karena
ia bertentangan dengan doktrin repo ini sendiri (*"gagal diam-diam adalah
kegagalan yang paling mahal"*): `/context` **menunggu tanpa batas dan tanpa
petunjuk**, padahal engine sudah memegang jawabannya. Kalau ini muncul lagi pada
orang yang tidak membaca dokumen ini, perbaikan di kode jadi pilihan yang benar.

### 10.5 Urutan yang diusulkan, dan kenapa `bot-02` terakhir

`bot-05` → `bot-04` → `bot-03` → `bot-01` → **`bot-02` paling akhir**.

`bot-01` menjelang akhir karena ia penyumbang 102 dari 139 `/switch` seluruh
armada plus 27 `edit_message` — ia bot yang paling merasakan celah yang belum
ditutup (`edit_message` masih hilang; `/switch` sudah ada sejak 0.41.0).

`bot-02` **paling akhir karena ia sesi yang mengerjakan migrasi ini**.
Menutupnya mengakhiri percakapan yang memegang seluruh konteks, jadi ia harus
jadi yang terakhir supaya keempat bot lain selesai selagi masih ada yang bisa
membaca hasilnya dan memperbaiki kalau meleset. Untuk `bot-02` sendiri, satu-satunya
yang tersisa adalah menjalankan skrip di §10.3 — itulah sebabnya ia ada.

---

## 11. Untuk yang membaca sesudah ini

- Konfigurasi rujukannya bukan dokumen ini melainkan **`mirza_01_bot/.claude/settings.json`**.
  Kalau keduanya berbeda, yang di folder itu yang benar.
- Yang mengubah folder jadi bot cuma `config.json`. Kalau `bot-06` diam total,
  panggil salah satu tool MCP dan baca alasannya — engine sistem baru **tidak
  pernah mati diam-diam** (mode `unavailable`).
- Angka pemakaian per bot (`/switch`, `edit_message`, lampiran) bisa dihitung
  ulang dari `messages.db` masing-masing bot lama; skripnya disebut di
  `celah-migrasi-hitung-ulang` §7.
