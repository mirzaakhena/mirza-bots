# Review menyeluruh `mirza-bots` — daftar hal yang bisa diperbaiki

**Tanggal:** 2026-08-10 · **Cakupan:** seluruh `cc-plugin` + `cc-wrapper` + `bin/` + `README.md`
**Basis:** commit `e21d6cf` (0.38.0), pohon kerja bersih.

**Yang diperiksa:** 19.130 baris (kode + test), `bun test` dijalankan pada kedua paket
(671 hijau di `cc-plugin`, 61 hijau di `cc-wrapper`), `tsc --noEmit` bersih di keduanya.

Temuan diurut dari yang paling bisa dibuktikan ke yang paling spekulatif. Setiap
entri menyebut **bukti**, bukan kecurigaan — dan yang belum diverifikasi
dinyatakan begitu apa adanya.

> **Status per 2026-08-10 (0.40.0):** **A-1, A-2, A-3, A-7, A-8, dan A-10 sudah
> diperbaiki.** Sisanya masih terbuka. Lihat catatan **✅ SUDAH DIPERBAIKI** di
> masing-masing entri.

---

## A. Bug yang bisa dibuktikan sekarang

### A-1 · Hook `SessionStart` membuat `logs/` di **setiap** folder, bot atau bukan

`hooks/session-start.ts` memanggil `note(cwd, "fired")` **sebelum**
`isBotFolder(cwd)` diperiksa. `note()` melakukan `mkdirSync(<cwd>/logs)` lalu
append — jadi berkasnya lahir sebelum ada yang tahu folder itu bot atau bukan.

**Bukti di workspace ini, bukan hipotesis:**

```
/c/Users/Mirza/workspace/bot-01/logs/session-hook.log   ← tidak ada config.json
/c/Users/Mirza/workspace/bot-02/logs/session-hook.log   ← tidak ada config.json
… bot-03, bot-04, bot-05, bot-06 sama
```

isinya persis mengaku:

```
2026-08-08T01:06:14.591Z fired
2026-08-08T01:06:14.591Z no config.json in C:/Users/Mirza/workspace/bot-05 -- nothing to record
```

Yang membuat ini layak diperbaiki bukan ukurannya, melainkan bahwa komentar di
berkas itu sendiri sudah menyatakan niat yang berlawanan:

> *"saying so here would mean shouting in every unrelated project the user opens"*

Niatnya benar; yang bocor justru berkasnya, bukan kalimatnya.

**✅ SUDAH DIPERBAIKI (0.40.0).** `isBotFolder` naik ke baris pertama
`runHook`, sebelum apa pun — termasuk sebelum stdin dibaca. Folder yang bukan
bot tidak menerima satu byte pun.

Alurnya dipindahkan ke `runHook(deps)` dengan efek sampingnya disuntik, supaya
URUTANNYA yang diuji, bukan cuma hasilnya: sebuah test memastikan `note` dan
`writeSessionId` tidak pernah dipanggil untuk folder non-bot. Diperiksa dengan
mutation check — mencabut satu baris guard itu membuat testnya merah.

"fired" tetap dicatat untuk folder bot, dan di situlah ia memang berguna:
membedakan hook yang gagal dari hook yang tidak pernah menyala. Untuk folder
yang bukan bot tidak ada yang bisa gagal, jadi tidak ada yang perlu dibedakan.

⚠️ Berkas `logs/session-hook.log` yang TERLANJUR ada di `bot-01`..`bot-06`
tidak ikut dihapus — membersihkan folder orang lain bukan hak perbaikan ini.
Hapus sendiri kalau mengganggu.

---

### A-2 · `callback_data` dari tool `reply` tidak dijaga batas 64 byte

`buildInlineKeyboard` (`engine/messages.ts`) meneruskan `btn.data` apa adanya ke
grammy. Telegram menolak `callback_data` di atas **64 byte** dengan
`BUTTON_DATA_INVALID` (400).

Yang membuatnya mahal: tombol menempel pada potongan **terakhir**
(`planSendOptionsFor`), jadi pada balasan panjang potongan-potongan sebelumnya
**sudah mendarat di HP user** ketika error datang. AI menerima
`reply failed after N of M parts sent` dan tidak punya cara membatalkan yang
terlanjur terkirim.

Repo ini **sudah punya pelajarannya** — `MAX_CONFIRM_COMMAND_BYTES` di
`slash/index.ts`, lengkap dengan komentar "dihitung per byte, bukan per
karakter" — tapi pagarnya hanya dipasang di jalur slash-confirm, yaitu jalur
yang **mesin** yang mengisi datanya. Jalur `reply`, satu-satunya yang datanya
ditulis **AI**, tidak dijaga sama sekali.

Dua batas Telegram lain yang juga tidak dijaga: maksimum **8 tombol per baris**
dan **100 baris**.

**✅ SUDAH DIPERBAIKI (0.39.0).** `findUnsafeButtonData` di
`engine/messages.ts`, dipanggil dari `prepareReply` — tempat yang sama
`findMissingButtonNarration` dan `assertNoButtonsWithFiles` sudah duduk, dan
tempat yang kontraknya berbunyi *"kalau ada yang salah, tidak ada satu pun pesan
yang terlanjur berangkat"*. Dihitung `Buffer.byteLength(data, "utf8")`, dan
errornya menyebut label tombolnya supaya AI tahu yang mana.

**Yang sengaja TIDAK ikut dipasang:** batas jumlah tombol per baris. Saya tidak
menemukan angka yang bisa saya buktikan di Bot API — dan memasang batas yang
ditebak akan menolak balasan yang sebenarnya sah. Batas 64 byte itu tertulis di
dokumentasi resmi (`1-64 bytes`); yang lain tidak.

---

### A-3 · Tombol AI berprefiks `slash:` membajak lapisan slash — tanpa konfirmasi

Di `engine.ts` handler `callback_query:data`:

```ts
const slashTap = parseSlashCallback(ctx.callbackQuery.data);
const accepted  = await deliver(…, { pushToAi: slashTap === null });
if (accepted && slashTap !== null) {
  if (slashTap.kind === "go") handleConfirm(slashTap.command, …)   // → writePending
  if (slashTap.kind === "switch") handleSwitch(slashTap.sessionId, …)
}
```

`parseSlashCallback` hanya melihat **prefiks string**. Tool `reply` menerima
`buttons` bebas dari AI. Jadi sebuah tombol yang AI beri
`data: "slash:go:/clear"` — disengaja atau tidak, misalnya karena menyalin
contoh dari dokumen ini — akan, saat ditap user:

1. **tidak** sampai ke AI (`pushToAi: false`),
2. menulis `/clear` ke `slash/`,
3. dan cc-wrapper mengetikkannya ke Claude Code — **tanpa prompt konfirmasi**,
   karena prompt itu justru langkah yang dilewati.

Jalur `slash:sw:<apa pun>` lebih longgar lagi: `handleSwitch` menyuntik
`/resume <apa pun>` tanpa memvalidasi bahwa isinya UUID.

Ini bukan lubang keamanan terhadap orang luar (allowlist tetap berdiri), tapi ia
**jalur eskalasi dari isi balasan AI ke perintah Claude Code**, dan ia diam-diam
mencuri tombol dari fitur yang mengirimnya.

**✅ SUDAH DIPERBAIKI (0.39.0).** Dua pagar:

- `data` berprefiks `slash:` ditolak di `prepareReply` (lewat
  `findUnsafeButtonData`). Prefiksnya kini satu konstanta bersama,
  `SLASH_CALLBACK_NAMESPACE`, dipakai oleh yang **mengenali** dan yang
  **menolak** — jadi keduanya tidak bisa berbeda pendapat.
- `parseSlashCallback` memvalidasi bentuk UUID di cabang `switch`. Yang tidak
  cocok dijawab `null`, bukan error: bentuk asing diperlakukan seperti tombol
  fitur lain — diteruskan ke AI, bukan dieksekusi.

---

### A-4 · `commonMarkToMarkdownV2` tidak punya jaring pengaman, padahal `chunk.ts` punya

`planParts` memanggil `commonMarkToMarkdownV2(text)` di baris pertama, tanpa
`try/catch`. Kalau `telegramify-markdown` (remark) melempar untuk sebuah input,
**seluruh** balasan gagal — dan `prepareReply` melempar sebelum satu byte pun
berangkat, jadi user tidak menerima apa-apa.

Yang ganjil: berkas yang sama sudah memutuskan arah yang benar untuk kegagalan
sejenis. Ketika hasil escaping membengkak melewati 4096, potongannya dikirim
sebagai teks polos (`mv2: false`) dengan alasan yang dieja jelas:

> *"Jelek, tapi tidak ada yang hilang — dan 'isi lenyap tanpa sepatah kata'
> adalah kelas kegagalan yang proyek ini paling hindari."*

Alasan itu berlaku sama persis untuk konversi yang **melempar**, bukan cuma yang
membengkak.

**Perbaikan:** bungkus konversi; kalau melempar, kembalikan potongan itu apa
adanya sebagai teks polos.

---

### A-5 · `Engine.close()` tidak pernah dipanggil di produksi

`grep -rn "\.close()" cc-plugin/src cc-plugin/bin cc-plugin/hooks` hanya
menemukan `conversationsDb.close()` **di dalam** `Engine.close()` sendiri.
`main.ts` tidak memanggilnya, dan tidak ada satu pun handler `SIGINT`/`SIGTERM`/
`exit` di `cc-plugin`.

Konsekuensinya:

- `releaseBotLock` **tidak pernah** berjalan; `bot.pid` selalu tertinggal basi.
  README menjelaskan keadaan itu (`alive:false` dengan `pid` terisi) seolah
  kejadian luar biasa — padahal itu keadaan **normal** setiap kali sesi ditutup.
- `stopInboxScanner`, `typing.stopAll`, `stopSessionAnnouncer` adalah kode mati.
- Indikator "typing…" yang sedang menyala ikut mati bersama proses, jadi tidak
  ada gejala — tapi itu keberuntungan, bukan desain.

**Perbaikan — pilih satu, jangan biarkan menggantung:**
pasang `process.on("SIGTERM"|"SIGINT"|"exit", () => engine.close())` di
`main.ts`, **atau** hapus `close()` dan nyatakan di komentar bahwa siklus hidup
engine = siklus hidup proses. Yang tidak boleh adalah membiarkan fungsi
pembersih yang terlihat dipanggil padahal tidak.

---

### A-6 · `AlbumBuffer` tidak punya cara berhenti

`engine.close()` menghentikan typing, announcer, dan pemindai inbox — tapi tidak
`albumBuffer`. Timer debounce (1,5 dtk) dan hard-cap (8 dtk) yang masih hidup
akan memanggil `deliver` → `insertMessage` **sesudah** `conversationsDb.close()`,
yaitu `RangeError: Cannot use a closed database`.

Hari ini tersembunyi karena A-5 (close tidak pernah dipanggil). Begitu A-5
diperbaiki, ini muncul.

**Perbaikan:** tambahkan `AlbumBuffer.stopAll()` (clear semua timer, buang semua
bucket) dan panggil dari `close()` **sebelum** db ditutup.

---

### A-7 · `bin/doctor.ts` menulis ke disk sebelum memvalidasi

Urutannya:

```ts
ensureBotDirs(botHome);          // ← membuat data/ inbox/ slash/ logs/
loadConfig(configPathIn(botHome)); // ← baru di sini ketahuan ini bukan folder bot
```

Dan `buildDoctorReport` membuka `conversations.db`, yang **membuat berkasnya**
kalau belum ada.

README versi sebelumnya menyuruh persis hal yang memicunya:

```bash
cd cc-plugin
bun run doctor
```

Dijalankan begitu dari terminal biasa (tanpa `CLAUDE_PROJECT_DIR`), ia membuat
empat folder + satu database kosong **di dalam repo**, lalu gagal. Tidak
tertangkap `.gitignore` kecuali `*.db`.

**✅ SUDAH DIPERBAIKI (0.40.0).** Alurnya pindah ke `runDoctor(botHome, deps)`
di `engine/doctor.ts` dengan `loadConfig` dan `openDb` disuntik, jadi urutannya
bisa diuji: sebuah test memastikan `openDb` **tidak pernah dipanggil** ketika
config gagal dibaca. Mutation check dilakukan — membalik urutannya membuat
testnya merah.

`ensureBotDirs` dicabut seluruhnya dari `bin/doctor.ts`: membuat folder adalah
pekerjaan engine, yang melakukannya karena ia memang akan memakainya.
`buildDoctorReport` kini menerima `Database | null`, dan database yang belum ada
dilaporkan `conversationsReady: false` alih-alih dibuat.

Diverifikasi hidup: dijalankan dari `cc-plugin/` ia menjawab `{"ok": false, …}`,
keluar dengan kode 1, dan `ls` sesudahnya tidak menemukan satu folder baru pun.

---

### A-8 · Skrip migrasi mencetak token bot ke stdout, bahkan saat dry-run

`scripts/migrate-per-folder.ts` baris 202:

```ts
console.log(plan.newConfig.body.replace(/^/gm, "    "));
```

`newConfig.body` memuat `"token": "<token asli>"`. Dry-run — yang justru
dirancang supaya aman dijalankan dulu — mencetak token ke terminal, scrollback,
dan berkas log mana pun yang menangkapnya.

**✅ SUDAH DIPERBAIKI (0.40.0).** `redactTokenInConfig` — murni, diuji. Yang
ditulis ke disk tetap nilai aslinya; yang diredaksi hanya yang dicetak. Polanya
menelan pasangan escape, jadi token yang memuat kutip ganda tetap tertutup
seluruhnya — penyaring yang berhenti di kutip pertama akan membocorkan sisanya.

**Catatan tambahan:** README sendiri menandai skrip ini *"belum pernah dijalankan
atas state nyata"*, dan `~/.claude/mirza-bots/` sudah tidak dipakai sejak
2026-08-04. Kandidat kuat untuk **dihapus** — kode migrasi yang tidak pernah
dijalankan dan tidak lagi punya sumber adalah beban baca, bukan jaring pengaman.

---

### A-9 · Test suite menembak `api.telegram.org` sungguhan

Keluaran `bun test` di `cc-plugin`:

```
cc-plugin: setMyCommands failed for bot-settings-rusak (continuing): GrammyError: … (401: Unauthorized)
poller[bot-uji]: start failed (attempt 2, retry in 2000ms): GrammyError: Call to 'getMe' failed! (401: Unauthorized)
poller[bot-test]: start failed (attempt 1, retry in 1000ms): Error: ETIMEDOUT
```

`makeBot()` hanya memakai `TELEGRAM_API_ROOT` bila env var itu ada; test yang
merakit engine penuh tidak mengaturnya, jadi `bot.start()` dan `setMyCommands`
benar-benar keluar ke internet. Akibatnya:

- suite 10,6 detik untuk pekerjaan yang seharusnya sub-detik,
- perilaku **berbeda** saat offline atau di balik proxy,
- `ETIMEDOUT` yang muncul di atas adalah bukti sudah pernah terjadi,
- token-token uji dikirim ke pihak ketiga.

**Perbaikan:** setel `TELEGRAM_API_ROOT` ke server lokal (atau alamat mati) lewat
preload `bun test`, sehingga tidak ada test yang bisa lolos ke jaringan tanpa
menyatakannya.

---

### A-10 · `slash/` yang menumpuk dieksekusi seluruhnya saat wrapper akhirnya jalan

`writePending` menulis `{ command }` **tanpa stempel waktu**. cc-wrapper memindai
`slash/` tiap 500 ms dan mengantre **semua** yang ditemukannya — termasuk pada
tick pertama sesudah start.

Skenario nyata: user membuka folder bot dengan `claude` langsung (bukan lewat
`mirza-bot`), jadi tidak ada wrapper. Slash Telegram tetap ditulis — engine tidak
tahu wrapper ada atau tidak, dan memang tidak bisa tahu. Lima `/rename`, tiga
`/clear`, dua `/branch` menumpuk sepanjang sore. Besok pagi `mirza-bot`
dijalankan, dan sepuluh perintah itu **semuanya** disuntik berurutan ke sesi
baru, dengan jarak 1,5 detik.

**✅ SUDAH DIPERBAIKI (0.39.0).** `isStalePayload` + `STALE_PAYLOAD_MS`
(10 menit) di `cc-wrapper/src/inbox.ts`, dipakai loop pemindai `slash/`.

Yang dipakai **`mtime` berkasnya**, bukan stempel `ts` di dalam payload seperti
usul awal di atas. Alasannya: bentuk payload adalah kontrak antara dua paket
yang dirilis terpisah, dan `mtime` menjawab pertanyaan yang persis sama —
kapan berkas ini ditulis — tanpa satu pun penulis payload harus tahu pagar ini
ada. Kontrak yang tidak perlu diubah lebih baik tidak diubah.

Payload basi **di-parse dulu, baru dibuang**, supaya baris lognya bisa
**menyebut perintahnya**. Log yang cuma memuat nama berkas menyuruh pembacanya
menebak apa yang hilang — pelajaran yang sama dengan `describeDispatchFailure`.

`mtime` di masa depan (jam bergeser, berkas disalin) dijawab "tidak basi":
perintah yang dibuang tanpa sebab lebih membingungkan daripada perintah yang
berjalan sedikit telat.

---

## B. Beban yang tumbuh: performa dan disk

### B-1 · `listSessions` membaca **seluruh isi** setiap transcript

`sessions.ts::readOne` melakukan `readFileSync(file, "utf8")` lalu
`raw.split("\n")` untuk **setiap** `.jsonl` di direktori project, tiap kali
`/branch` atau `/switch` dipanggil.

Yang dibutuhkan cuma dua hal, dan keduanya ada di ujung berkas:
`custom-title` (terakhir) dan `forkedFrom` (pertama). Isi tengahnya — yaitu
99,9% byte-nya — dibaca dan di-`split` tanpa pernah dipakai.

Pada project dengan 30 sesi dan transcript ratusan MB (sesi 1M-context bukan
kasus langka di armada ini), satu tap `/switch` membaca semuanya ke RAM.

**Perbaikan:** baca **ekor** berkas dengan `fs.read` berjendela (mis. 64 KB
terakhir, mundur kalau tidak ketemu) untuk judul, dan **kepala** untuk
`forkedFrom`.

### B-2 · `reply-guard` mem-parse seluruh transcript di setiap akhir giliran

`hooks/reply-guard.ts` melakukan `readFileSync(path).split("\n")` lalu
`JSON.parse` per baris — **setiap kali** hook `Stop` berjalan, yaitu setiap
giliran. Biayanya tumbuh linear terhadap panjang sesi, jadi paling mahal justru
di sesi panjang, yaitu sesi yang paling sibuk.

Semua yang guard butuhkan adalah kejadian **terbaru** (`latestInboundIdx`,
`latestReplyIdx`, `latestProseIdx`, `latestAgentInboundIdx`).

**Perbaikan:** pindai N baris terakhir saja (mis. 2000). Kalau satu pun penanda
tidak ditemukan di jendela itu, mundur — jangan langsung menyerah.

### B-3 · `currentSessionName()` membaca ulang transcript **tiap 5 detik**

`announcerTimer` di `engine.ts` memanggil `currentSessionName()` →
`readSessionNameFromTranscript()` → `readFileSync` penuh + `split("\n")`, terus
menerus selama sesi hidup. Komentar di `session-title.ts` mengklaim
*"berhenti di sana berarti berkas 200 KB tidak perlu di-parse seluruhnya"* — yang
tidak di-parse cuma JSON-nya; berkasnya tetap dibaca dan di-split utuh.

**Perbaikan:** sama dengan B-1 (baca ekor), atau lewati pembacaan bila `mtime`
berkas tidak berubah sejak tick sebelumnya. Yang kedua paling murah dan menutup
mayoritas tick.

### B-4 · Tidak ada indeks yang cocok untuk query jangkar riwayat

```sql
SELECT id FROM messages WHERE message_id = ? ORDER BY id DESC LIMIT 1
```

Indeks yang ada adalah `idx_messages_message_id ON messages(bot, message_id)` —
kolom pertamanya `bot`, jadi query tanpa `bot` tidak bisa memakainya dan jatuh ke
full scan. Sementara komentar di `getMessagesAround` sudah menjelaskan dengan
benar **kenapa** filter `bot` sengaja dibuang; indeksnya saja yang tertinggal.

**Perbaikan:** `CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id)`.

### B-5 · `data/` dan `logs/` tumbuh tanpa batas dan tanpa laporan

Tiap foto dan dokumen yang user kirim disimpan permanen di `<bot>/data/`. Tidak
ada retensi, tidak ada pembersihan, dan `doctor` tidak melaporkan ukurannya.
Begitu armada harian yang enam ikut pindah ke sistem ini, ini kandidat paling
mungkin menghabiskan disk — dan gejalanya akan muncul sebagai unduhan gagal,
bukan sebagai pesan "disk penuh".

**Perbaikan minimum:** `doctor` melaporkan jumlah berkas + total byte `data/`.
Mengukur dulu, memutuskan retensi belakangan.

---

## C. Struktur dan risiko yang belum menggigit

### C-1 · Impor melingkar `server.ts ⇄ engine.ts ⇄ reminders.ts`

`reminders.ts` mengimpor `SYSTEM_TURN_MARKER` dari `../server`, sementara
`server.ts` mengimpor `Engine` dari `engine/engine.ts`, yang mengimpor
`reminders.ts`.

Ia selamat **hanya** karena konstanta itu dipakai di dalam badan
`renderReminders()` (live binding ESM), bukan di top-level. Satu baris seperti

```ts
const HEADER = `${SYSTEM_TURN_MARKER} pengingat:`;   // top-level
```

akan melempar `ReferenceError` saat boot — dan bentuk gagalnya adalah plugin yang
tidak menyala sama sekali, yaitu W-16 lagi.

**Perbaikan:** pindahkan `USER_TURN_MARKER`/`AGENT_TURN_MARKER`/
`SYSTEM_TURN_MARKER` ke `engine/markers.ts` yang tidak mengimpor apa pun.
Lingkarannya putus, dan hook yang menyalin literal-literal itu punya satu tempat
untuk diadu.

### C-2 · `bin/mirza-bot.cmd` mengunci satu mesin dan satu OS

```cmd
set "WRAPPER=C:\Users\Mirza\workspace\mirza-bots\cc-wrapper"
```

Path absolut milik satu mesin, di satu-satunya launcher yang ada, di repo yang
kriteria desainnya berbunyi *"instalasi serta struktur yang mudah dipelajari
orang lain"*. Tidak ada padanan `.sh`.

**Perbaikan:** turunkan dari letak berkasnya sendiri (`%~dp0..\cc-wrapper` bila
disalin bersama repo, atau baca `MIRZA_BOTS_REPO` bila disalin ke PATH), dan
tambahkan `bin/mirza-bot` untuk shell POSIX.

### C-3 · Jenis pesan yang tidak didukung hilang **tanpa jejak apa pun**

`voice`, `video`, `video_note`, `sticker`, `audio`, `location`, `contact`,
`poll`, dan `edited_message` tidak punya handler. README menyebut empat yang
pertama "diabaikan diam-diam, disengaja" — tapi konsekuensinya lebih besar dari
yang tertulis: pesannya **tidak masuk `conversations.db` sama sekali**. Jadi
pertanyaan "kok bot-nya diam?" tidak bisa dijawab dari database; harus ditebak.

Itu bertentangan dengan doktrin yang repo ini pegang di mana-mana: *yang tidak
meninggalkan jejak tidak bisa diukur*.

**Perbaikan:** satu handler `bot.on("message")` terdaftar **paling akhir** yang
mencatat baris `kind: "unsupported"` ke database (tanpa mendorong ke AI). Murah,
dan mengubah "misteri" jadi satu query.

### C-4 · Grup: ditolak diam-diam, dan tidak ada tempat untuk mengetahuinya

`isAllowed` mencocokkan `chat.id` terhadap `allowFrom`. Di grup, `chat.id`
negatif dan tidak akan pernah cocok, jadi bot yang ditambahkan ke grup **bisu
total** — tanpa log, tanpa baris database, tanpa apa pun.

Terkait: field-nya bernama `allowFrom` dan README menyebutnya "daftar user ID",
padahal yang dicocokkan `chat_id`. Di chat pribadi keduanya sama angkanya, jadi
salah namanya belum pernah menggigit — dan justru itu yang membuatnya menunggu.

**Perbaikan:** minimal catat satu baris stderr saat pesan grup ditolak; dan
luruskan nama/dokumentasinya jadi "chat id".

### C-5 · Poller yang tuli tidak bisa dibedakan dari poller yang sehat

`startPolling` mengulang selamanya dengan backoff maksimum 15 detik. Token yang
dicabut menghasilkan bot yang **hidup, terdaftar, tool-nya menjawab** — tapi
tidak pernah menerima satu pesan pun, selamanya, dan satu-satunya jejaknya baris
stderr yang tidak ada yang baca. `doctor` tidak melaporkannya; `agent_status`
tidak melaporkannya.

**Perbaikan:** tulis keadaan poller ke berkas (`poller.state`: waktu sukses
terakhir + galat terakhir), dan tampilkan di `doctor`. "Hidup" dan "mendengar"
adalah dua fakta berbeda, dan sekarang hanya yang pertama bisa ditanyakan.

### C-6 · `send_slash` tidak menolak perintah yang mengakhiri sesi

`TELEGRAM_ONLY` menolak empat command lapisan Telegram. Tidak ada daftar untuk
perintah yang **mematikan sesi** (`/exit`, `/quit`, `/logout`). AI bisa
mematikan sesinya sendiri — dan karena umur bot = umur sesi, ia mematikan
botnya sendiri. *(Belum diverifikasi apakah CC benar-benar punya `/exit`;
verifikasi dulu sebelum memasang pagarnya.)*

### C-7 · Ceruk-ceruk kecil

- **Deskripsi tool `search_history` salah:** ia mengatakan *"operators like
  AND/OR are rejected by the search engine"*. FTS5 justru **mendukung**
  `AND`/`OR`/`NOT`. Deskripsi yang berbohong ke AI membuatnya menghindari sesuatu
  yang bekerja.
- **`MAX_BODY_BYTES` (8 KB) tidak disebut di deskripsi `agent_send`** — AI baru
  tahu setelah ditolak.
- **Nama berkas unduhan bisa bentrok:** `${stamp}-${safeName}`; dua dokumen
  bernama sama dalam milidetik yang sama saling menimpa. Sangat kecil
  kemungkinannya, tapi `randomUUID()` pendek menutupnya tanpa biaya.
- **`typing.stop()` dipanggil di awal `sendOutgoing`**, jadi kalau `prepareReply`
  menolak (mis. pagar tombol bernomor), indikator sudah padam padahal giliran
  masih berjalan dan AI akan mengirim ulang.
- **`cc-plugin/package.json` tidak punya `test` maupun `typecheck`**, padahal
  komentar di sepanjang repo menekankan `bun test` tidak memeriksa tipe.
  `cc-wrapper` punya keduanya. Satu ketidaksamaan yang membuat langkah paling
  penting harus diingat alih-alih dijalankan.
- **Tidak ada CI sama sekali** (`.github/workflows` tidak ada). Untuk repo yang
  seluruh doktrinnya berbunyi "mesin yang menjaga, bukan ingatan", ini lubang
  paling mencolok.
- **PID reuse:** `agentStatuses()` menyimpulkan `online` dari
  `process.kill(pid, 0)`. PID yang sudah dipakai proses lain akan dilaporkan
  online. Sangat kecil; disebut supaya tidak dianggap jaminan.

---

## D. README

Sudah ditulis ulang bersama review ini. Yang **terukur salah** di versi
sebelumnya, dicatat di sini supaya bisa diperiksa ulang:

| Klaim lama | Kenyataan |
|---|---|
| "bun test — 274 test" | 671 (`cc-plugin`) + 61 (`cc-wrapper`) |
| "Yang belum ada: … konversi CommonMark→MarkdownV2 (2.5-KELUAR) — sampai itu ada, `**bintang**` tampil mentah" | Sudah ada, dan README yang sama menjelaskannya sendiri 60 baris di atasnya. Dua paragraf saling membantah. |
| "`/switch` belum ada — ia butuh daftar sesi bernama" | Ada sejak 0.37.0 |
| "Yang belum ada: PTY `bot-cc`" | Digantikan `cc-wrapper`, dan README yang sama sudah mengatakannya |
| Contoh path `/Users/mirza/Workspace/mirza-bots` | Armadanya Windows: `C:\Users\Mirza\workspace\mirza-bots` |
| Contoh keluaran doctor `"version": "0.13.0"` | 0.38.0 |
| "folder sesi itu sama dengan `home` salah satu bot di `config.json`" | `home` sudah tidak ada di skema config; identitas = nama folder |

Yang **tidak didokumentasikan sama sekali** meski sudah hidup: `agent_status`,
`send_slash`, `/branch`, `/switch`, lampiran `files` pada `reply`, pengumuman
sesi otomatis, pengingat mesin `[from: system]`, aturan bernama +
`logs/violations.jsonl`.

---

## E. Urutan yang saya sarankan

Bukan daftar keinginan — urutannya mengikuti "berapa yang hilang kalau tidak
dikerjakan", bukan "berapa mudah dikerjakan".

1. ~~**A-2, A-3**~~ ✅ **selesai 0.39.0** — keduanya di jalur `reply`, keduanya
   bisa merusak sesuatu yang user lihat, keduanya satu fungsi (`prepareReply`).
2. ~~**A-10**~~ ✅ **selesai 0.39.0** — dinaikkan dari urutan 5 setelah dipikir
   ulang: pemicunya bukan skenario eksotis melainkan cara pakai yang README
   sendiri dokumentasikan (`claude` langsung, tanpa wrapper).
3. ~~**A-1, A-7, A-8**~~ ✅ **selesai 0.40.0** — tiga efek samping yang menulis
   ke tempat yang bukan haknya. Kecil satu-satu, dan justru karena itu tidak
   pernah dikerjakan.
4. **A-5 + A-6 bersamaan** — jangan diperbaiki terpisah; A-5 sendirian
   memunculkan A-6.
5. **A-9, C-7 (script `test`/`typecheck`), CI** — memasang pagar sebelum
   menambah apa pun di atasnya.
6. **A-4, C-3, C-5** — tiga bentuk "hilang tanpa jejak", persis kelas kegagalan
   yang repo ini paling mahal membayarnya.
7. **B-1..B-5** — beban yang belum menggigit tapi tumbuh setiap hari.
8. **C-1, C-2** — utang struktur; kerjakan saat menyentuh berkasnya, jangan
   dijadikan proyek sendiri.
