# LAPORAN W-27: chat_id persisten sesudah restart engine

## Bukti worktree yang benar

```
$ git rev-parse --show-toplevel
C:/Users/Mirza/workspace/mirza-bots-bot-03-w27
$ git branch --show-current
w27-chat-id-persisten
```

Dijalankan SEBELUM perintah pertama apa pun, sesuai instruksi. Tidak pernah menyentuh
`C:/Users/Mirza/workspace/mirza-bots` (main), tidak checkout/merge/push.

## Apa yang diubah

1. **`cc-plugin/src/engine/db/conversations-schema.ts`** -- fungsi baru `getLastChatId(db)`:
   `SELECT chat_id FROM messages ORDER BY id DESC LIMIT 1`. Tanpa penyaring `bot`, mengikuti
   pola `getMessagesAround`/`searchMessages` yang sudah ada di file yang sama (database ini
   sudah milik satu bot sesudah state per-folder). `id DESC`, bukan `ts DESC`, karena `id`
   AUTOINCREMENT mengikuti urutan INSERT sebenarnya, sedangkan `ts` datang dari jam Telegram
   di sisi pengirim dan bisa kembar/tidak monoton.

2. **`cc-plugin/src/engine/engine.ts`** -- `reply()` (sekitar baris 678-708):
   - `chatId` sekarang `let`, bukan `const`.
   - Kalau `lastChatByBot.get(botName)` kosong, dicoba `getLastChatId(conversationsDb)`
     (variabel `conversationsDb` sudah ada di closure yang sama sejak baris 346 -- tidak ada
     jalur baru ke database, mengikuti instruksi eksplisit di brief).
   - Kalau database punya sesuatu, `chatId` diisi DAN ditulis balik ke `lastChatByBot` supaya
     baca database hanya terjadi sekali per proses.
   - Kalimat error diganti (lihat di bawah).
   - Import `getLastChatId` ditambahkan ke baris import `db/conversations-schema` yang sudah
     ada.

3. **`cc-plugin/test/engine/engine.test.ts`** -- 3 test baru + 1 assert tambahan di test lama
   (lihat bagian TDD).

4. **Versi**: `cc-plugin/package.json` dan `cc-plugin/.claude-plugin/plugin.json`,
   `0.14.0` -> `0.15.0`, keduanya.

### Kalimat error versi baru (disalin utuh)

```
no_known_chat: this bot has never received a message from anyone -- not in this process, and not in its conversation history either -- so there is nobody to reply to. Ask the user to send this bot a message first.
```

Tidak menyebut Telegram sama sekali; menyebut sebab (belum pernah menerima pesan dari
siapa pun -- BUKAN "belum di sesi ini") dan tindakan yang diperlukan (user kirim pesan
lebih dulu). Bahasa Inggris karena dibaca AI (K-16).

## Bukti TDD

### 1. Test ditulis lebih dulu, tiga buah (plus 1 assert negatif di test lama)

- `reply falls back to the latest chat_id in conversations.db when lastChatByBot is empty`
- `reply uses the newest chat_id when conversations.db has more than one`
- `reply still refuses when conversations.db is genuinely empty, without blaming Telegram`
- (tambahan) assert `expect(message).not.toContain("Telegram")` ditambahkan ke test lama
  `reply before any message has arrived explains itself instead of guessing a chat`.

Ketiga test baru memakai `withFakeTelegram()` (helper baru di file test yang sama), sebuah
`Bun.serve` lokal yang menjawab `sendMessage`/`getMe`/`getUpdates`/lainnya secara generik
lewat `TELEGRAM_API_ROOT`, supaya `reply()` bisa benar-benar mengirim (bukan cuma
menegaskan bahwa ia TIDAK melempar) tanpa menyentuh Telegram sungguhan. `sentTo` menangkap
`chat_id` yang benar-benar dikirim di body request, dipakai test #2 untuk membuktikan
urutan "terbaru" bukan kebetulan.

### 2. RED -- dijalankan sebelum implementasi, MERAH dengan alasan yang benar

```
$ bun test test/engine/engine.test.ts

test\engine\engine.test.ts:
676 |         replyTo?: string,
677 |         files?: string[]
678 |       ): Promise<ReplyResult> {
679 |         const chatId = lastChatByBot.get(botName);
680 |         if (!chatId) {
681 |           throw new Error(
                          ^
error: no_known_chat: this bot has not received a message yet, so there is nobody to reply to
      at reply (...\engine.ts:681:21)
      at <anonymous> (...\engine.test.ts:213:37)
(fail) reply falls back to the latest chat_id in conversations.db when lastChatByBot is empty [16.00ms]
... (pola sama)
(fail) reply uses the newest chat_id when conversations.db has more than one [31.00ms]

 9 pass
 2 fail
 21 expect() calls
Ran 11 tests across 1 file. [302.00ms]
```

Alasannya benar: kedua test gagal PERSIS di titik `no_known_chat` yang lama (fallback
database belum ada), bukan karena salah ketik/setup. Test #3 (database kosong, assert
negatif) sudah lolos dari awal -- ia pagar regresi, bukan target implementasi baru; itu
konsisten dengan brief ("tolak, dengan kalimat yang benar").

### 3. GREEN -- sesudah implementasi

```
$ bun test test/engine/engine.test.ts
 11 pass
 0 fail
 23 expect() calls
Ran 11 tests across 1 file. [331.00ms]
```

### 4. Gerbang penuh

```
$ bun test
 488 pass
 0 fail
 987 expect() calls
Ran 488 tests across 46 files. [2.64s-3.54s across runs]

$ bunx tsc --noEmit
(tidak ada output -- exit 0)
```

485 (baseline) + 3 (test baru) = 488. Tetap 0 fail. Noise pre-existing (`401 Unauthorized`,
`ETIMEDOUT`, `404` dari test poller) tidak disentuh, sesuai instruksi.

## Bukti mutasi

Mutasi: cabang fallback database di `reply()` dimatikan (`const fromDb: string | null =
null;` menggantikan `getLastChatId(conversationsDb)`, ditandai komentar
`MUTANT_W27_DISABLED`).

**Mutasi terpasang (grep -c = 1):**
```
$ grep -c "MUTANT_W27_DISABLED" src/engine/engine.ts
1
```

**Test MERAH dengan mutasi terpasang:**
```
$ bun test test/engine/engine.test.ts

test\engine\engine.test.ts:
697 |             chatId = fromDb;
698 |             lastChatByBot.set(botName, chatId);
699 |           }
700 |         }
701 |         if (!chatId) {
702 |           throw new Error(
                          ^
error: no_known_chat: this bot has never received a message from anyone -- not in this process, and not in its conversation history either -- so there is nobody to reply to. Ask the user to send this bot a message first.
      at reply (...\engine.ts:702:21)
      at <anonymous> (...\engine.test.ts:213:37)
(fail) reply falls back to the latest chat_id in conversations.db when lastChatByBot is empty [31.00ms]
... (pola sama)
(fail) reply uses the newest chat_id when conversations.db has more than one [32.00ms]

 9 pass
 2 fail
 21 expect() calls
Ran 11 tests across 1 file. [531.00ms]
```

**Mutasi dicabut, dibuktikan (grep -c = 0):**
```
$ grep -c "MUTANT_W27_DISABLED" src/engine/engine.ts
0
```

**Gerbang penuh sesudah mutasi dicabut (final):**
```
$ bun test
 488 pass
 0 fail
 987 expect() calls
Ran 488 tests across 46 files. [2.71s]

$ bunx tsc --noEmit
tsc exit: 0
```

Test #1 dan #2 menjaga persis apa yang mereka klaim jaga: mematikan fallback membuat
keduanya merah dengan alasan yang benar (kembali ke `no_known_chat` lama), dan
mengembalikannya membuatnya hijau lagi.

## `git diff --stat`

```
 cc-plugin/.claude-plugin/plugin.json            |   2 +-
 cc-plugin/package.json                          |   2 +-
 cc-plugin/src/engine/db/conversations-schema.ts |  25 ++++++
 cc-plugin/src/engine/engine.ts                  |  28 +++++-
 cc-plugin/test/engine/engine.test.ts            | 114 ++++++++++++++++++++++++
 5 files changed, 166 insertions(+), 5 deletions(-)
```

## Keputusan desain -- tidak dibantah

Instruksi melarang fallback ke `allowFrom[0]`, dengan alasan `allowFrom` adalah daftar
"boleh", bukan "pernah bicara". Setuju sepenuhnya, tidak ada keberatan: `getLastChatId`
membaca `conversations.db`, yang HANYA berisi baris yang ditulis sesudah gerbang allowlist
lolos (lihat komentar `deliverIncoming` di `messages.ts` -- `lastChatByBot` ditulis
"strictly after the allowlist gate accepted the message", dan baris database ditulis oleh
jalur yang sama). Jadi fallback ini BUKAN sumber baru yang bisa salah kirim ke orang yang
belum pernah lolos gerbang; ia cuma memori jangka panjang dari sumber yang sama yang sudah
dipercaya sebelum restart.

Konsekuensi yang diterima sadar sesuai brief: bot yang belum pernah disapa siapa pun --
`conversations.db` kosong -- tetap tidak bisa memulai. Di titik itu memang Telegram yang
melarang (bot tidak bisa mengirim ke chat_id yang tidak pernah ada), tapi kalimat errornya
sengaja tidak menyebutnya, karena AI tidak perlu tahu ATURAN Telegram untuk mengerti
tindakan yang perlu diambil (minta user mengirim pesan dulu).

## Keraguan

- Test #1 dan #2 mendirikan `Bun.serve` lokal dan mengarahkan `TELEGRAM_API_ROOT` (env
  var proses) ke situ untuk membuat `reply()` benar-benar berhasil mengirim, lalu
  mengembalikannya di blok `finally`. Ini pola BARU di `engine.test.ts` (test lain di file
  itu hanya menguji kegagalan/penolakan, tidak pernah kirim sungguhan) -- meniru pola
  `Bun.serve` yang sudah ada di `poller.test.ts`/`media.test.ts`, tapi ini pemakaian
  pertamanya lewat `startEngine()` penuh, bukan lewat `handleIncomingMessage` langsung. Saya
  yakin ini benar (terbukti RED lalu GREEN lalu mutasi-MERAH), tapi menandainya karena
  polanya baru di file ini.
- `bot.start()` polling latar belakang milik `startEngine` tidak dihentikan oleh
  `engine.close()` (perilaku pre-existing, bukan yang saya ubah). Sesudah test #1/#2
  menutup `server.stop()` di blok `finally`, polling latar belakang bot itu akan gagal
  connect ke port yang sudah mati dan log error lewat jalur retry `poller.ts` yang sudah
  ada (sama seperti noise `ETIMEDOUT`/`401` pre-existing) -- tidak menggagalkan test, hanya
  menambah baris log serupa saat `bun test` penuh dijalankan. Tidak saya perbaiki karena di
  luar cakupan W-27 dan pre-existing behaviour `close()`.
