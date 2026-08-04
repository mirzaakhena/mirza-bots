# mirza-bots

Fleet harness untuk bot Telegram berbasis Claude Code. **Dua paket:**

| Paket | Perannya | Runtime |
|---|---|---|
| **`cc-plugin`** | Seluruh engine — penarik pesan Telegram, database, tool MCP. Berjalan di dalam proses tiap sesi Claude Code | Bun |
| **`cc-wrapper`** | Membungkus Claude Code di dalam PTY supaya slash command CC bisa disuntikkan dari luar sesi | **Node + `tsx`** |

Perbedaan runtime itu **bukan pilihan gaya**: `pty.write()` gagal di Bun 1.3.11
dengan `ERR_SOCKET_CLOSED` sementara Node v22 bekerja. Diukur, bukan ditebak —
`cc-wrapper/PROBE.md`. Test kedua paket tetap `bun test`, karena seluruh logika
`cc-wrapper` ada di modul murni yang tidak menyentuh `node-pty`.

**Tidak ada daemon.** `fleetd` dibubarkan 2026-08-02: alasannya, ongkos
menjalankan dan mengawasinya, ada di
`mirza-marketplace/docs/superpowers/specs/2026-08-02-penyatuan-engine-fleetd-design.md`.

**Tidak ada state bersama.** Sejak 2026-08-04, seluruh state satu bot hidup di
folder bot itu sendiri — token, riwayat, sesi, status, kunci. `~/.claude/mirza-bots/`
tidak dipakai lagi. Kriteria yang membingkainya, dari user: *"instalasi serta
struktur yang mudah dipelajari orang lain"* — dan sesuatu mudah dipelajari kalau
orang bisa **menebak di mana barangnya** tanpa membaca dokumen.

Efek samping yang diinginkan: **memindahkan bot = rename folder.**

Konsekuensi yang diterima sadar: **bot hanya hidup selama ada sesi Claude Code
terbuka.** Pesan tidak hilang — Telegram menahan update yang belum diambil
sampai 24 jam — tapi balasannya menunggu sesi berikutnya dibuka.

Arsitektur aslinya (tiga komponen: `fleetd`, `bot-cc`, `cc-plugin`) didesain di
`docs/superpowers/specs/2026-07-27-fleet-harness-rebuild-design.md`; bagian
`fleetd`-nya sudah digantikan spec di atas.

## Status: Tahap 2 (Jalur Pesan) + fondasi `cc-wrapper`

Jalur pesan dua arah sudah hidup: **Telegram → sesi Claude Code → balik lagi ke
Telegram**, seluruhnya dalam satu proses (`cc-plugin`).

**`cc-wrapper` fondasinya berdiri sejak 2026-08-03** dan terverifikasi hidup:
perintah tunggal maupun batch mendarat di TUI, termasuk saat CC sedang sibuk.
Menggantikan rencana lama "`bot-cc`" — alasan terbesarnya dulu ("menyalakan
`fleetd` bila belum berjalan") memang hilang bersama daemonnya, tapi **alasan
yang jauh lebih besar menggantikannya**: sejak daemon dibubarkan, umur sesi =
umur bot, jadi wrapper adalah satu-satunya hal yang membuat bot selamat dari
sesi yang crash.

Desainnya:
`mirza-marketplace/docs/superpowers/specs/2026-08-03-cc-wrapper-design.md`.

**Diverifikasi hidup dengan bot Telegram sungguhan (2026-07-30, `bot-01`):**
teks, foto tunggal, album (3 foto → 1 baris tergabung), dan tombol inline
(termasuk `answerCallbackQuery` scar-tissue check) semua terkonfirmasi
bekerja end-to-end. Lihat "Memasang `cc-plugin` di Claude Code" di bawah
untuk prosedur instalasi yang benar-benar teruji (§ berbeda dari desain awal
— butuh capability `claude/channel` + plugin ter-instal, bukan cuma dimuat
sesi).

### Fondasi (Tahap 1)

- **Konfigurasi tervalidasi ketat.** `config.json` divalidasi lewat zod
  (`z.strictObject`) — field yang salah nama atau kosong ditolak, bukan
  didiamkan.
- **Satu database SQLite:** `conversations.db` — riwayat percakapan dengan
  pencarian teks penuh (FTS5), disinkron otomatis lewat trigger SQL setiap kali
  baris pesan ditambah/diubah/dihapus.
  **`fleet.db` dibuang 2026-08-04** (`3451037`). Ia dulu memegang state
  operasional (`sessions`, `handoffs`, `injections`, `bot_inbox`, `incidents`),
  dan diukur satu per satu: keempat tabel pertama **nol baris dan nol rujukan
  kode**, lalu `bot_inbox` ternyata ikut mati bersama daemonnya — poller kini
  berjalan di dalam proses yang memegang token, jadi "tidak ada sesi" berarti
  "tidak ada poller", dan Telegram sendiri menahan update yang belum diambil
  selama 24 jam. Itu persis peran `bot_inbox` dulu.
- **Kunci satu-penarik-per-token** (`bot.pid` di folder bot) — dijelaskan di
  "Menjalankan" di bawah.
- **`doctor`** — status check untuk **satu** bot: namanya, kesiapan
  `conversations.db`-nya, dan siapa yang memegang tokennya. Ia berhenti
  melaporkan armada karena sesudah state per-folder ia tidak bisa tahu:
  `ls workspace/*/bot.pid` menjawabnya tanpa berpura-pura.

### Jalur pesan masuk (Tahap 2 + 2.5-MASUK)

- **Poller Telegram** (satu per bot, lewat grammy) menerima:
  - **teks**,
  - **foto tunggal** — diunduh ke `data/` milik bot itu lalu dicatat sebagai
    attachment,
  - **album** (beberapa foto sekaligus) — disatukan jadi **satu** pesan
    lewat buffer debounce, bukan tiga pesan terpisah,
  - **tombol inline** (`callback_query`) — selalu di-*acknowledge* supaya
    tombol tidak berputar selamanya di HP, lalu isi tombolnya dikirim ke AI.
- **Allowlist di depan segalanya.** Pesan dari chat ID di luar `allowFrom`
  (untuk chat pribadi ini sama dengan user ID pengirim; grup belum didukung,
  §"belum ada" di bawah) dijatuhkan sebelum disimpan, sebelum di-push, dan sebelum chat-nya boleh
  jadi tujuan balasan AI berikutnya.
- **Pesan yang datang saat bot mati tidak hilang.** Tidak ada antrean sendiri
  untuk itu, dan tidak perlu: poller berjalan di dalam proses yang memegang
  token, jadi "tidak ada sesi" berarti "tidak ada yang mengambil", dan Telegram
  menahan update yang belum diambil selama **24 jam**. Tabel `bot_inbox` yang
  dulu melakukan tugas ini dibuang 2026-08-04 bersama daemonnya.
- **`cc-plugin`** — plugin Claude Code (MCP server) yang **berisi engine-nya**:
  ia menentukan bot mana dirinya dari folder kerja sesi, mengklaim token bot itu,
  menarik pesannya sendiri, menyediakan tool **`reply`** (teks + tombol opsional)
  untuk membalas ke Telegram, dan meneruskan pesan masuk ke sesi sebagai
  notifikasi.
- **Penjaga balasan (`Stop` hook).** Kalau giliran berakhir sementara belum ada
  `reply` sejak pesan masuk terakhir, hook ini **memblokir sekali** dan menyuruh
  AI menjawab dulu. Ada karena orang yang mengirim pesan sedang membaca Telegram,
  bukan transkrip — giliran yang berakhir tanpa `reply` menghasilkan **diam
  total** yang tidak bisa ia bedakan dari bot rusak. Protokol terse-turn menaikkan
  risikonya (menutup giliran dengan "." membuat "sudah menjawab" dan "lupa
  menjawab" tampak sama), jadi penjaganya mesin, bukan ingatan AI.

- **Indikator "typing…" hidup sepanjang giliran.** Menyala begitu pesan masuk
  lolos allowlist, diperbarui tiap 4 detik, dan berhenti di balasan pertama.
  Indikator Telegram sendiri padam ~5 detik setelah pembaruan terakhir,
  sementara 97,6% giliran berlangsung lebih lama dari itu — satu tembakan
  seperti sistem lama akan senyap sepanjang sisa giliran. Ada batas aman 300
  detik supaya giliran yang mati tanpa membalas tidak meninggalkan indikator
  nyangkut.

- **Dokumen** (PDF, zip, `.md`, `.log`, `.txt`) diunduh otomatis sampai **20 MB**
  — batas Telegram sendiri untuk bot, jadi tidak ada aturan tambahan yang perlu
  diingat. Di atas itu berkasnya tidak diambil dan AI diberi tahu (nama +
  ukuran lewat `meta`, plus satu kalimat pemberitahuan di isi pesan) — ditolak,
  bukan didiamkan. Nama berkas kiriman pengirim selalu lewat `safeName()`.
- **Kutipan (quote-reply) arah masuk.** Baik kutip seluruh pesan maupun seleksi
  sebagian: teks kutipannya ikut ke AI lewat `meta` (`quote_text`,
  `quote_is_manual`) dan id pesan yang dikutip lewat `reply_to_message_id`.
- **Album yang dikeraskan:** maksimum 10 item, diurutkan `message_id` menaik
  (bukan urutan tiba), satu foto gagal unduh tidak lagi menjatuhkan seluruh
  pesan, dan caption dari beberapa foto sekaligus diberi label `Photo <n>:`.
- **Dua tool riwayat untuk AI:** `read_history` (ambil pesan di sekitar sebuah
  `message_id` — inilah yang membuat "telusuri beberapa pesan setelah yang saya
  kutip" bisa dijawab) dan `search_history` (cari kata kunci, lewat FTS5).
  Keduanya **selalu membaca percakapan bot pemanggil**, dan tidak ada cara
  menyeberang. Parameter `bot` opsional yang dulu ada dibuang 2026-08-04 atas
  keputusan user: ia menjanjikan sesuatu yang tidak bisa diberikan begitu tiap
  bot memegang `conversations.db`-nya sendiri. Diukur sebelum dibuang —
  lintas-bot belum pernah benar-benar terjadi.
- **Keyboard dicopot setelah tombol ditap.** Pesannya diedit tanpa `reply_markup`
  (itulah yang mencopot keyboard-nya) dan ditambahi `→ <pilihan>`, jadi prompt yang
  sama tidak bisa dijawab dua kali. Entities aslinya dikirim ulang supaya format
  tidak terhapus, dan penandanya ditempel di akhir supaya offset lama tetap sah.
- **Tombol bernomor wajib punya keterangannya.** Engine **menolak** `reply` yang
  labelnya angka telanjang bila badan pesannya tidak memuat daftar bernomor yang
  cocok — ditolak sebelum apa pun terkirim, dan pesan errornya menyebutkan cara
  memperbaikinya. Aturan ini dulu hanya hidup sebagai teks yang meminta AI
  mengingatnya, dan bocor tiga kali dalam dua hari.
- **Orientasi waktu lokal.** `config.json` menerima `timezone` opsional (nama
  IANA); saat diisi, push `meta` mendapat `ts_local` di samping `ts` yang **tetap
  UTC**. Penyimpanan sengaja tidak diubah — UTC tidak ambigu, bisa diurutkan, dan
  kebal DST; yang ditambahkan hanya cara menampilkannya.
- **Balasan keluar ikut disimpan.** Barisnya ber-`source='assistant'` berikut
  `message_id` yang dikembalikan Telegram, dan disimpan **sesudah** kirim
  berhasil — id itu hanya ada di jawaban Telegram, dan baris tanpa id tidak bisa
  dikutip belakangan. Sebelum ini `read_history` menyajikan transkrip sepihak.
- **Balasan panjang dipotong otomatis.** Di atas batas keras Telegram (4096
  karakter setelah escaping), balasan dikirim sebagai beberapa pesan berurutan
  tanpa penanda. Tombol menempel di pesan terakhir, kutipan di pesan pertama,
  dan tiap pesan disimpan satu baris sehingga bisa dikutip belakangan. Pedoman
  menulis: ±1000 karakter — pedoman, bukan gerbang; tidak ada yang ditolak
  karena kepanjangan.
- **Bot bisa mengutip.** Tool `reply` menerima `reply_to` berisi id pesan yang
  dikutip — pesan user maupun pesan bot sendiri. **AI tidak boleh pernah meminta
  id itu ke user** (U-3); kalau tidak punya, minta user meng-*quote*.
- **Markdown dikonversi otomatis, tanpa flag.** AI menulis CommonMark biasa
  (`**tebal**`, `` `kode` ``, blok berpagar, tautan) dan engine mengubahnya ke
  MarkdownV2 — termasuk meng-escape tiap `. - ( ) ! +` yang kalau tidak, membuat
  Telegram menolak seluruh pesan dengan 400. **Yang disimpan ke database tetap
  teks aslinya**, bukan hasil escape.
- **Identitas sesi dibaca, bukan dipotret.** Hook `SessionStart` menulis id sesi
  terbaru ke `session.id` di folder bot; engine membacanya tiap kali push. Tanpa ini,
  `/clear` membuat pesan berikutnya distempel id sesi lama — terukur 2026-08-02.
- **Slash Telegram dicegat SESUDAH dicatat, tidak sebelum.** `/rename <nama>`
  dan `/new <nama>` dari Telegram tidak lagi diteruskan ke AI: keduanya diolah
  jadi payload dan ditulis ke `pending/` milik `cc-wrapper` (`/new` =
  `[/clear, /rename <nama>]`, urutannya bagian dari kontrak). Slash yang **tidak**
  dikenal tidak ditolak — ia dapat tombol **Kirim/Batal** lebih dulu, karena
  sebagian slash CC interaktif dan injeksi yang membukanya lalu berhenti
  meninggalkan TUI menggantung. **Urutan catat-lalu-cegat itu inti aturannya:**
  sistem lama mencegat sebelum mencatat, dan biayanya nyata — audit membaca
  `/switch` sebagai 0× dipakai padahal 139×. Karena `handleIncomingMessage`
  mencatat **dan** mendorong ke AI dalam satu fungsi, jalur `deliver` punya opsi
  `pushToAi`: yang ditekan hanya pendorongannya, pencatatan tetap tanpa syarat.
  Indikator "typing…" ikut padam untuk slash — tidak ada giliran AI yang
  disiapkan. Batas `callback_data` dijaga **55 byte** (prefiks `slash:go:`
  memakan 9 dari 64 yang Telegram izinkan), dihitung per byte dan bukan per
  karakter. Terverifikasi hidup 2026-08-04 pada `bot-uji`, enam dari enam
  kriteria, diperiksa dari `conversations.db` dan `session-hook.log` — bukan
  dari layar. Desainnya:
  `mirza-marketplace/docs/superpowers/specs/2026-08-03-lapisan-slash-telegram-design.md`.
  **`/context` menyusul di tahap 2** (butir berikutnya). **`/switch` belum ada**
  — ia butuh daftar sesi bernama, dan itu pekerjaan tersendiri.
- **`/context` dijawab tanpa mengorbankan statusline user.** Payload statusline
  di-**push** Claude Code ke command-nya lewat stdin dan tidak bisa ditarik
  kapan pun — jadi satu-satunya cara memperolehnya adalah **menjadi** command
  itu, menangkapnya, dan menyimpannya (`status.json` di folder bot). Karena Claude Code
  hanya mengizinkan **satu** `statusLine`, meneruskan ke statusline pendahulu
  bukan pilihan gaya melainkan satu-satunya jalan yang tidak menggusurnya.
  **Sistem lama menggusurnya, dan masih menggusurnya di enam dari enam bot
  harian:** installer-nya mencari statusline pendahulu di lapisan **project**
  padahal punya user ada di **global**, lalu menulis `previousCommand ?? ''` —
  string kosong — sehingga `if (chain)` tidak pernah benar. Tidak ada satu pun
  langkah yang error; baris statusnya sekadar jadi kosong. Yang mematikan bukan
  salah lapisannya, melainkan memperlakukan `null` sebagai *"memang tidak ada"*
  padahal artinya *"aku tidak menemukannya"*. Empat pagar mencegah itu berulang:
  **(1)** resolusi mengikuti presedens CC, project **lalu** global; **(2)** rantai
  ditulis lalu **dibaca ulang**, tidak cocok berarti **rollback**; **(3)** kalau
  installer tidak bisa memastikan apa yang terpasang, ia **menolak memasang** dan
  `/context` melapor apa adanya — lebih baik `/context` mati daripada statusline
  user mati; **(4)** tiap pagar punya *mutation check* yang membuktikan testnya
  bisa merah. Di bridge, prioritas itu terbaca dari strukturnya: blok penangkap
  dibungkus `try/catch` dan blok penerus berada **di luar** jangkauannya, jadi
  gagal menangkap tidak pernah mematikan statusline. Bridge tidak mencetak apa
  pun ke stdout sendiri. `/context` **tidak dikirim ke CC sama sekali** — ia
  dijawab dari berkas tangkapan. Pada pemasangan pertama berkas itu belum ada
  (CC belum sempat menggambar baris status), jadi bot membalas "⏳ menunggu"
  lalu **menunggu berkasnya muncul** — yang ditunggu kejadiannya, bukan durasi
  yang ditebak. Menjawab "belum ada data" di detik pemasangan benar secara
  harfiah tapi menyesatkan: yang perlu dilakukan user cuma menunggu. Nama sesi diambil dari `session_name` di dalam
  payload, ditulis CC sendiri, jadi fitur ini tidak menunggu daftar sesi bernama.
  Desainnya: `mirza-marketplace/docs/superpowers/specs/2026-08-04-context-telegram-design.md`.
- **Menu "/" didaftarkan ke Telegram.** `setMyCommands` dipanggil sekali saat
  engine boot, daftarnya lahir dari `KNOWN_COMMANDS` — sumber yang sama yang
  memutuskan apa yang dicegat, jadi menu dan perilaku tidak bisa berbeda
  pendapat. Sengaja hanya memuat yang benar-benar bekerja: menu adalah papan
  nama, bukan dapur. Panggilannya tidak fatal — bot yang menolak melayani pesan
  karena gagal memperbarui menu menukar yang penting dengan yang tidak.
- **Belum ditangani, disengaja:** voice note, video, video_note, dan sticker.
  Pesan jenis itu diabaikan diam-diam — kalau suatu hari muncul keluhan "kok
  bot-nya diam?", ini kandidat pertama yang diperiksa, bukan misteri baru.

Yang **belum** ada (menyusul di tahap berikutnya): PTY `bot-cc`,
handoff/delegasi antar-bot, routing sesi yang sebenarnya (untuk sekarang
`reply` menyasar chat terakhir yang menyapa bot itu, disimpan di memori dan
hilang saat sesinya ditutup), dan konversi CommonMark→MarkdownV2 (2.5-KELUAR)
— sampai itu ada, `**bintang**` tampil mentah di Telegram.

## Instalasi

Butuh [Bun](https://bun.sh) 1.3+. Satu paket:

```bash
cd cc-plugin && bun install
```

### Launcher `mirza-bot`

`bin/mirza-bot.cmd` (Windows) menjalankan satu bot lewat `cc-wrapper` dari mana
saja. Pasang dengan menyalinnya ke folder yang ada di PATH:

```bash
cp bin/mirza-bot.cmd ~/.local/bin/
```

```
mirza-bot         jalan, cepat, tanpa menyentuh jaringan
mirza-bot -u      update cc-plugin dulu, baru jalan
```

Selalu memakai folder tempat kamu berdiri. **Tidak menerima nama bot atau
path** — tiap bot dijalankan dari foldernya sendiri, jadi argumen itu tidak
pernah dipakai, dan parameter yang tidak dipakai tetap berbiaya: percabangan
yang harus dibaca, baris dokumentasi yang harus dirawat.

**Update ada di belakang `-u`** karena terukur mahal (2026-08-04): ~**6,5
detik**, dan **5,6 detik** di antaranya `marketplace update` yang menembak
GitHub. Tanpa flag, start hanya ~**0,3 detik**.

Versi `cc-plugin` yang **benar-benar terpasang** dicetak saat start, dibaca dari
`installed_plugins.json`. Plugin dimuat dari **cache** dan bukan dari repo, jadi
angka itu satu-satunya petunjuk murah bahwa kode yang berjalan sudah usang — dua
kali di proyek ini waktu terbuang menguji perbaikan yang ternyata tidak pernah
dijalankan. Ketinggalan → ulangi dengan `-u`.

Sengaja terpisah dari `mirza-cc`, launcher sistem lama: berkas itu melayani bot
harian, dan menumpanginya berarti mempertaruhkan yang produksi demi yang
percobaan.

## Konfigurasi

### Memasang bot baru

Tiga langkah, dan tidak ada langkah keempat:

1. Buat sebuah folder. **Namanya adalah nama botnya.**
2. Isi `config.json` di dalamnya:

```json
{
  "token": "TOKEN_BOT_TELEGRAM",
  "allowFrom": ["123456789"],
  "timezone": "Asia/Jakarta"
}
```

3. Jalankan `mirza-bot` dari folder itu.

- `token` — token dari BotFather, milik bot INI.
- `allowFrom` — daftar user ID Telegram yang boleh memakainya.
- `timezone` — opsional, nama zona IANA. Salah ketik menghilangkan waktu lokal,
  tidak menghentikan bot.

**Sebuah folder adalah bot bila ia memuat `config.json`.** Aturan itu dipakai
tiga kali: engine memakainya untuk tahu siapa dirinya, hook SessionStart untuk
tahu apakah perlu mencatat apa pun, dan jalur antar-bot untuk tahu folder
tetangga mana yang bisa dititipi pesan.

### Isi folder bot

```
<nama-bot>/
├── config.json        token + allowFrom + timezone bot INI
├── conversations.db   riwayat bot INI
├── session.id         id sesi Claude Code terbaru (ditulis hook)
├── status.json        tangkapan statusline (ditulis bridge)
├── bot.pid            pemegang token
├── chained-statusline statusline pendahulu yang diteruskan bridge
├── data/              berkas & gambar yang dikirim user
├── inbox/             titipan pesan dari bot lain
└── logs/              session-hook.log
```

Semuanya dibuat sendiri saat bot pertama kali dijalankan, kecuali `config.json`
yang memang harus ditulis manusia.

Tidak ada env var untuk memindahkan state. `MIRZA_BOTS_HOME` **dibuang** —
ia ada untuk memindahkan *state root*, dan tidak ada lagi state root.

### Migrasi dari bentuk lama

Bot yang masih memakai `~/.claude/mirza-bots/`:

```bash
# lihat rencananya dulu -- tidak ada yang ditulis
bun run scripts/migrate-per-folder.ts ~/.claude/mirza-bots <folder-bot> <nama-bot>

# baru salin
bun run scripts/migrate-per-folder.ts ~/.claude/mirza-bots <folder-bot> <nama-bot> --apply
```

Skrip **menyalin**, tidak memindahkan, dan tidak pernah menghapus apa pun —
state lama sengaja ditinggalkan utuh sampai kamu sendiri yakin bot barunya
jalan. Ia juga menyebut setiap berkas lama yang tidak punya tujuan dan setiap
bot lain yang belum dimigrasikan, karena "yang baru muncul" tidak pernah
membuktikan "yang lama tidak ketinggalan".

⚠️ **Skrip ini belum pernah dijalankan atas state nyata.** Testnya memakai
folder tiruan.

## Menjalankan

**Tidak ada yang perlu dinyalakan.** Engine hidup di dalam sesi Claude Code:
buka sesi di folder yang terdaftar sebagai `home` sebuah bot, dan bot itu mulai
menarik pesan.

### Satu penarik per token

Telegram hanya mengizinkan **satu** konsumen `getUpdates` per token. Dua
penarik tidak menghasilkan galat yang keras — mereka membagi pesanmu secara
acak, yang terbaca sebagai "botnya kadang mendengar".

Karena itu tiap sesi mengklaim `bot.pid` di folder botnya saat
start. **Sesi terbaru menang:** kalau kunci itu dipegang proses yang masih
hidup, sesi baru menghentikannya dan mengambil alih, lalu mencatatnya ke
stderr. Sesi lama berhenti menerima pesan Telegram — itu disengaja, dan bukan
kerusakan.

Enam bot dengan enam token berbeda **tidak pernah** berebut; kunci ini hanya
soal satu bot dengan dua sesi.

### Memeriksa keadaan

```bash
cd cc-plugin
bun run doctor
```

Contoh keluaran:

```json
{
  "ok": true,
  "bot": "mirza_01_bot",
  "lock": { "bot": "mirza_01_bot", "pid": 41234, "alive": true },
  "conversationsReady": true,
  "version": "0.11.0"
}
```

`lock` selalu ada, dipegang atau tidak — `pid: null` berarti tidak ada sesi
yang melayani bot ini sekarang, dan `alive: false` dengan `pid` terisi berarti
kuncinya basi (sesi mati tanpa melepasnya). Membedakan "tidak berjalan" dari
"aman" adalah seluruh guna laporan ini, jadi keadaan kosong pun dilaporkan
alih-alih dihilangkan.

### Kalau bot ini tidak mau bicara

Engine **tidak pernah mati diam-diam**. Kalau ia tidak bisa start, plugin tetap
hidup dan ketiga tool-nya tetap ada — tiap panggilan menjawab dengan alasannya,
mis. *"This directory (...) is not the home of any bot in config.json …
registered bots: bot-uji"*. Kalau kamu melihat pesan seperti itu, perbaiki
`config.json` lalu buka ulang sesinya.

## Memasang `cc-plugin` di Claude Code

**Verifikasi lapangan (Task 10, 2026-07-30, waktu daemonnya masih ada):**
pesan masuk sampai ke proses `cc-plugin` dengan benar lewat `.mcp.json`/`--plugin-dir` biasa —
tapi notifikasinya **tidak pernah muncul di sesi Claude Code**, tanpa error apa
pun. Root cause: Claude Code hanya meneruskan `notifications/claude/channel`
dari MCP server yang (a) mendeklarasikan capability `experimental: {
"claude/channel": {} }`, DAN (b) sesi itu dijalankan dengan
`--dangerously-load-development-channels plugin:<nama>@<marketplace>` di mana
`<nama>@<marketplace>` menunjuk plugin yang **benar-benar terinstal**
(`--plugin-dir` session-scoped saja TIDAK cukup — errornya `plugin not
installed`). Sistem lama (`plugins/telegram` di `mirza-marketplace`) sudah
memenuhi keduanya sejak awal; `cc-plugin` tadinya tidak (capability-nya
hilang). Prosedur di bawah ini sudah teruji hidup, bukan asumsi.

### Sekali saja: registrasi lokal

`cc-plugin/src/server.ts` sudah mendeklarasikan capability yang diperlukan.
`cc-plugin` juga perlu ada di sebuah *marketplace* supaya bisa di-`install`
(bukan cuma dimuat sesi) — repo ini punya marketplace lokalnya sendiri di
`.claude-plugin/marketplace.json` (tidak untuk distribusi, cuma supaya
`claude plugin install` punya sesuatu untuk ditunjuk). Jalankan sekali:

```bash
claude plugin marketplace add /Users/mirza/Workspace/mirza-bots
claude plugin install cc-plugin@mirza-bots
```

### Setiap kali `cc-plugin` diubah

**`claude plugin install` TIDAK cukup** — kalau plugin-nya sudah terpasang, ia
menjawab *"already installed"* dan diam-diam tetap memakai build lama. Terbukti
2026-07-31: perbaikan yang sudah di-commit tidak pernah sampai ke sesi sampai
langkah di bawah dijalankan. Urutan yang benar, ketiganya:

1. **Naikkan versi** di `cc-plugin/.claude-plugin/plugin.json` (dan
   `package.json` supaya selaras). Tanpa ini, `update` tidak melihat ada yang
   perlu diambil.
2. **Segarkan marketplace lalu update plugin-nya:**

```bash
claude plugin marketplace update mirza-bots
claude plugin update cc-plugin@mirza-bots
```

3. **Restart sesi Claude Code** yang memakai plugin itu — `update` sendiri
   mengingatkan *"Restart to apply changes"*; sesi yang sedang berjalan tetap
   menjalankan kode lama sampai dibuka ulang.

⚠️ **Langkah 3 bukan formalitas, dan tidak ada apa pun yang mengingatkanmu kalau
ia terlewat.** Claude Code mengunci versi plugin saat sesi dibuka. Sebuah sesi
yang mulai 14 menit sebelum sebuah perbaikan dipasang akan terus menjalankan
versi lama sampai dibuka ulang — termasuk hook-nya, yang bisa memblokir giliran
dengan logika yang sudah dihapus dari repo. Persis itu yang terjadi 2026-08-02
(W-18), dan gejalanya sama sekali tidak menunjuk ke versi.

Pastikan dengan `claude plugin list | grep -A 2 cc-plugin` bahwa versinya
memang yang baru.

### Setiap sesi

Syarat satu-satunya: folder sesi itu sama dengan `home` salah satu bot di
`config.json`. Tidak ada daemon yang harus dinyalakan lebih dulu.

Kalau tidak cocok, plugin **tetap start** dan tiap tool menjawab dengan
alasannya, berikut daftar bot yang terdaftar — ia tidak lagi menghilang tanpa
suara (W-16). Identitas itu diambil lewat `resolveIdentityCwd()`
(`cc-plugin/src/main.ts`):
mengutamakan env var `CLAUDE_PROJECT_DIR`, baru jatuh ke `process.cwd()` kalau
env var itu tidak ada — **terverifikasi bekerja** persis dengan `home` di
`config.json` untuk `bot-01` (`/Users/mirza/Workspace/mirza-bots`), tanpa
masalah symlink `/var` vs `/private/var`.

Buka sesi Claude Code dengan working directory **persis** `home` bot itu, dan
flag channel menunjuk plugin yang sudah terinstal di atas:

```bash
cd /Users/mirza/Workspace/mirza-bots
claude --dangerously-load-development-channels "plugin:cc-plugin@mirza-bots"
```

Flag ini *research-preview* (belum di allowlist Anthropic) — sama seperti yang
sudah dipakai produksi untuk `plugins/telegram@mirza-marketplace`, bukan hal
baru yang berisiko di repo ini. Notifikasi masuk (▎ *Channels (experimental)…*)
akan muncul begitu sesi terbuka; pesan Telegram sungguhan langsung tampil
sebagai giliran baru di sesi.

Tidak ada lagi koneksi yang bisa putus di tengah: engine hidup di dalam proses
plugin itu sendiri, jadi ia hidup dan mati bersamanya. Yang bisa terjadi
sebagai gantinya adalah **pengambilalihan token** — sesi lain di folder bot yang
sama mengklaim kuncinya, dan sesi ini berhenti menerima pesan. Itu dicatat ke
stderr oleh sesi yang mengambil alih.

### Protokol giliran ringkas (terse-turn)

Sesi yang dipicu pesan Telegram menerima pesannya dengan awalan
`[protocol: terse-turn]` (definisi otoritatifnya adalah `TERSE_TURN_MARKER`
di `cc-plugin/src/server.ts` — kalau nilainya berubah, dokumen ini harus
ikut diperbarui). Artinya bagi AI: jawab lewat tool `reply` saja,
lalu tutup giliran dengan satu titik — jangan menulis prosa di transkrip.
Alasannya: user yang memakai Telegram memang sedang jauh dari terminal dan
tidak membaca transkrip itu, sementara isinya tetap dibayar token dan tetap
menumpuk di context window sesi.

Protokol lengkapnya tinggal di field `instructions` MCP milik `cc-plugin`
(dibayar sekali per sesi), bukan diulang di tiap pesan. Aturan ini **hanya**
berlaku untuk giliran yang datang dari Telegram — giliran yang kamu ketik
langsung di terminal dijawab lengkap seperti biasa.

Ini optimasi yang gagal dengan aman: kalau AI mengabaikannya, yang terjadi
cuma kembali ke perilaku lama (prosa panjang di transkrip). Tidak ada jalur
yang putus.

## Testing

```bash
cd cc-plugin && bun test     # 274 test
```

Mencakup validasi config, kedua skema database (termasuk sinkronisasi trigger
FTS5 saat update/delete), gerbang allowlist beserta jaminan bahwa chat yang
ditolak tidak pernah jadi tujuan balasan, penyatuan album, redaksi token bot di
pesan error, kunci satu-penarik-per-token, resolusi identitas bot dari folder
sesi, perakitan engine, tool MCP (dengan dan tanpa tombol), penerusan push,
pembubuhan marker terse-turn, dan **mode `unavailable`**: kalau engine gagal
start, ketiga tool tetap terdaftar dan menjawab dengan alasan yang bisa dibaca
manusia.
