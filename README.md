# mirza-bots

Fleet harness untuk bot Telegram berbasis Claude Code. Satu program latar
belakang (`fleetd`) memegang seluruh logika dan penyimpanan untuk beberapa
bot sekaligus, lepas dari sesi Claude Code mana pun — sehingga bot tetap
hidup walau sesi di-reset, di-`/clear`, atau crash.

Arsitektur lengkapnya (tiga komponen: `fleetd`, `mirza-cc`, `cc-plugin`)
didesain di repo `mirza-marketplace`
(`docs/superpowers/specs/2026-07-27-fleet-harness-rebuild-design.md`) — README
ini sengaja tidak menduplikasinya, hanya mendokumentasikan apa yang **sudah
ada di repo ini**.

## Status: Tahap 1 (Fondasi)

Baru `fleetd` yang ada, dan baru fondasinya — **belum ada koneksi Telegram
sama sekali**. Yang sudah berjalan:

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
  — pola dasar yang nanti dipakai hook dan koneksi panjang MCP.
- **`doctor`** — status check yang melaporkan jumlah bot terdaftar, tabel
  yang ada, dan kesiapan kedua database.

Yang **belum** ada (menyusul di tahap berikutnya): poller Telegram, PTY
`mirza-cc`, plugin Claude Code, handoff/delegasi antar-bot.

## Instalasi

Butuh [Bun](https://bun.sh) 1.3+.

```bash
cd fleetd
bun install
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

## Testing

```bash
cd fleetd
bun test
```

18 test — mencakup validasi config, kedua skema database (termasuk
sinkronisasi trigger FTS5 saat update/delete), protokol socket (termasuk
kasus pesan terpotong lintas paket), dan satu test end-to-end yang benar-benar
menyalakan `fleetd` sebagai proses terpisah lalu bicara dengannya lewat
socket — bukan simulasi in-process.
