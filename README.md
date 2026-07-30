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

### Jalur pesan (Tahap 2)

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

Ulangi `claude plugin install cc-plugin@mirza-bots` setiap kali `cc-plugin`
diubah — instalasi tidak otomatis mengikuti perubahan source (lihat
`claude plugin update cc-plugin@mirza-bots` sebagai alternatif).

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

## Testing

```bash
cd fleetd && bun test        # 59 test
cd ../cc-plugin && bun test  # 16 test
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
penerusan push, dan perilaku saat `fleetd` menghilang.
