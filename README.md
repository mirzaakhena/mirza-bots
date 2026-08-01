# mirza-bots

Fleet harness untuk bot Telegram berbasis Claude Code. Satu program latar
belakang (`fleetd`) memegang seluruh logika dan penyimpanan untuk beberapa
bot sekaligus, lepas dari sesi Claude Code mana pun — sehingga bot tetap
hidup walau sesi di-reset, di-`/clear`, atau crash.

Arsitektur lengkapnya (tiga komponen: `fleetd`, `bot-cc`, `cc-plugin`)
didesain di repo `mirza-marketplace`
(`docs/superpowers/specs/2026-07-27-fleet-harness-rebuild-design.md`) — README
ini sengaja tidak menduplikasinya, hanya mendokumentasikan apa yang **sudah
ada di repo ini**.

## Status: Tahap 2 (Jalur Pesan)

Jalur pesan dua arah sudah hidup: **Telegram → `fleetd` → sesi Claude Code →
balik lagi ke Telegram**. Dua paket yang ada sekarang: `fleetd` (daemon) dan
`cc-plugin` (plugin Claude Code). PTY `bot-cc` belum ada.

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
- **Dua database SQLite terpisah**, sesuai prinsip "state kecil yang boleh
  hilang" vs "riwayat besar yang tak boleh hilang":
  - `fleet.db` — state operasional: `sessions`, `handoffs`, `injections`,
    `bot_inbox`, `incidents`. Aman dihapus & dibangun ulang.
  - `conversations.db` — riwayat percakapan dengan pencarian teks penuh
    (FTS5), disinkron otomatis lewat trigger SQL setiap kali baris pesan
    ditambah/diubah/dihapus.
- **Soket Unix** (`fleetd.sock`) dengan protokol JSON satu baris per pesan
  — pola dasar yang nanti dipakai hook dan koneksi panjang MCP. Setiap
  request divalidasi zod di batas soket (`fleetd` satu-satunya titik
  validasi), dan request yang cacat selalu dijawab `{"ok":false,...}` —
  tidak pernah menggantung pemanggilnya.
- **`doctor`** — status check yang melaporkan jumlah bot terdaftar, tabel
  yang ada, dan kesiapan kedua database.

### Jalur pesan masuk (Tahap 2 + 2.5-MASUK)

- **Poller Telegram** (satu per bot, lewat grammy) menerima:
  - **teks**,
  - **foto tunggal** — diunduh ke `inbox/<bot>/` lalu dicatat sebagai
    attachment,
  - **album** (beberapa foto sekaligus) — disatukan jadi **satu** pesan
    lewat buffer debounce, bukan tiga pesan terpisah,
  - **tombol inline** (`callback_query`) — selalu di-*acknowledge* supaya
    tombol tidak berputar selamanya di HP, lalu isi tombolnya dikirim ke AI.
- **Allowlist di depan segalanya.** Pesan dari chat ID di luar `allowFrom`
  (untuk chat pribadi ini sama dengan user ID pengirim; grup belum didukung,
  §"belum ada" di bawah) dijatuhkan sebelum disimpan, sebelum di-push, dan sebelum chat-nya boleh
  jadi tujuan balasan AI berikutnya.
- **Antrean offline (`bot_inbox`).** Kalau pesan masuk saat tidak ada sesi
  Claude Code yang terhubung, pesan itu ditulis ke `bot_inbox`. Begitu ada
  plugin yang menyambung (`hello`), antreannya langsung dikuras dan dikirim —
  jadi pesan yang datang waktu bot "mati" tidak hilang.
- **`cc-plugin`** — plugin Claude Code (MCP server) yang menyambung ke
  `fleetd.sock`, mengenalkan diri lewat `hello` (identitasnya = folder kerja
  sesi), menyediakan tool **`reply`** (teks + tombol opsional) untuk membalas
  ke Telegram, dan meneruskan pesan masuk ke sesi sebagai notifikasi.
- **Penjaga balasan (`Stop` hook).** Kalau giliran berakhir sementara belum ada
  `reply` sejak pesan masuk terakhir, hook ini **memblokir sekali** dan menyuruh
  AI menjawab dulu. Ada karena orang yang mengirim pesan sedang membaca Telegram,
  bukan transkrip — giliran yang berakhir tanpa `reply` menghasilkan **diam
  total** yang tidak bisa ia bedakan dari bot rusak. Protokol terse-turn menaikkan
  risikonya (menutup giliran dengan "." membuat "sudah menjawab" dan "lupa
  menjawab" tampak sama), jadi penjaganya mesin, bukan ingatan AI.

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
  Keduanya **default ke bot pemanggil**; melihat percakapan bot lain hanya
  terjadi kalau parameter `bot` disebut sengaja.
- **Keyboard dicopot setelah tombol ditap.** Pesannya diedit tanpa `reply_markup`
  (itulah yang mencopot keyboard-nya) dan ditambahi `→ <pilihan>`, jadi prompt yang
  sama tidak bisa dijawab dua kali. Entities aslinya dikirim ulang supaya format
  tidak terhapus, dan penandanya ditempel di akhir supaya offset lama tetap sah.
- **Tombol bernomor wajib punya keterangannya.** `fleetd` **menolak** `reply` yang
  labelnya angka telanjang bila badan pesannya tidak memuat daftar bernomor yang
  cocok — ditolak sebelum apa pun terkirim, dan pesan errornya menyebutkan cara
  memperbaikinya. Aturan ini dulu hanya hidup sebagai teks yang meminta AI
  mengingatnya, dan bocor tiga kali dalam dua hari.
- **Orientasi waktu lokal.** `config.json` menerima `timezone` opsional (nama
  IANA); saat diisi, push `meta` mendapat `ts_local` di samping `ts` yang **tetap
  UTC**. Penyimpanan sengaja tidak diubah — UTC tidak ambigu, bisa diurutkan, dan
  kebal DST; yang ditambahkan hanya cara menampilkannya.
- **Belum ditangani, disengaja:** voice note, video, video_note, dan sticker.
  Pesan jenis itu diabaikan diam-diam — kalau suatu hari muncul keluhan "kok
  bot-nya diam?", ini kandidat pertama yang diperiksa, bukan misteri baru.

Yang **belum** ada (menyusul di tahap berikutnya): PTY `bot-cc`,
handoff/delegasi antar-bot, routing sesi yang sebenarnya (untuk sekarang
`reply` menyasar chat terakhir yang menyapa bot itu, disimpan di memori dan
hilang saat `fleetd` restart).

## Instalasi

Butuh [Bun](https://bun.sh) 1.3+. Dua paket, masing-masing punya dependensi
sendiri:

```bash
cd fleetd && bun install
cd ../cc-plugin && bun install
```

## Konfigurasi

Buat `~/.claude/mirza-bots/config.json` (folder ini dibuat otomatis oleh
`fleetd` kalau belum ada):

```json
{
  "allowFrom": ["123456789"],
  "bots": {
    "bot-01": {
      "home": "/Users/kamu/Workspace/project-bot-01",
      "token": "TOKEN_BOT_TELEGRAM"
    }
  }
}
```

- `allowFrom` — daftar user ID Telegram yang boleh memakai bot.
- `bots` — satu entri per bot. Nama bot bebas (jadi key), `home` folder
  kerja bot itu, `token` token BotFather. Boleh lebih dari satu bot.

Path lain yang dipakai `fleetd`, semuanya di bawah `~/.claude/mirza-bots/`:
`fleet.db`, `conversations.db`, `fleetd.sock`, `inbox/`, `logs/`.

**Untuk testing tanpa menyentuh folder asli**, override dengan env var
`MIRZA_BOTS_HOME=/path/ke/folder/sementara` — semua path di atas ikut
pindah ke situ.

## Menjalankan

```bash
cd fleetd
bun run start     # menyalakan fleetd, dengar di socket
```

Di terminal lain, cek statusnya:

```bash
cd fleetd
bun run doctor
```

Contoh keluaran:

```json
{
  "ok": true,
  "report": {
    "botCount": 1,
    "socketPath": "/Users/kamu/.claude/mirza-bots/fleetd.sock",
    "fleetTables": ["sessions", "handoffs", "injections", "bot_inbox", "incidents"],
    "conversationsReady": true,
    "version": "0.1.0"
  }
}
```

## Memasang `cc-plugin` di Claude Code

**Verifikasi lapangan (Task 10, 2026-07-30):** pesan masuk sampai ke `fleetd`
dan ke proses `cc-plugin` dengan benar lewat `.mcp.json`/`--plugin-dir` biasa —
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

Pastikan dengan `claude plugin list | grep -A 2 cc-plugin` bahwa versinya
memang yang baru.

### Setiap sesi

Syaratnya: `fleetd` sudah jalan lebih dulu, dan identitas yang dikirim plugin
lewat `hello` sama dengan `home` salah satu bot di `config.json`. Kalau tidak
cocok, `hello` dijawab `unknown_cwd` dan plugin gagal start dengan pesan itu.
Identitas itu diambil lewat `resolveIdentityCwd()` (`cc-plugin/src/main.ts`):
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

Kalau `fleetd` di-restart saat sesi hidup, koneksi plugin ikut mati: `reply`
akan langsung gagal dengan error "connection lost"/"not connected" — bukan
menggantung. Sambungkan ulang lewat `/mcp` di Claude Code (koneksi soket akan
tersambung ulang; flag channel tidak perlu diulang karena itu properti sesi,
bukan koneksi MCP).

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
cd fleetd && bun test        # 59 test
cd ../cc-plugin && bun test  # 19 test
```

`fleetd` — mencakup validasi config, kedua skema database (termasuk
sinkronisasi trigger FTS5 saat update/delete), protokol socket (termasuk
kasus pesan terpotong lintas paket, request cacat, dan handler yang melempar),
gerbang allowlist beserta jaminan bahwa chat yang ditolak tidak pernah jadi
tujuan balasan, penyatuan album, redaksi token bot di pesan error, lalu
beberapa test end-to-end yang benar-benar menyalakan `fleetd` sebagai proses
terpisah — dengan Telegram API palsu, bukan simulasi in-process — dan
membuktikan pesan yang masuk saat tidak ada plugin tersambung tetap terkirim
setelah plugin menyambung.

`cc-plugin` — handshake `hello`, tool `reply` (dengan dan tanpa tombol),
penerusan push, perilaku saat `fleetd` menghilang, deklarasi `instructions`
MCP, serta pembubuhan marker terse-turn pada pesan yang diteruskan (baik
pesan biasa maupun penekanan tombol).
