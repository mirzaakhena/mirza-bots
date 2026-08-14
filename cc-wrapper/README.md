# cc-wrapper

Membungkus Claude Code di dalam PTY supaya slash command CC bisa disuntikkan
**dari luar sesi** — oleh plugin Telegram, oleh bot lain, atau oleh penjadwal.

Analogi yang dipakai sepanjang desainnya: **tukang ketik buta yang bisa meraba
meja.** Ia tidak melihat layar, tapi bisa meraba beberapa benda untuk tahu apa
yang sudah terjadi. Jeda waktu adalah tebakan; rabaan adalah bukti.

**Desain lengkap:**
`mirza-marketplace/docs/superpowers/specs/2026-08-03-cc-wrapper-design.md`
**Pengukuran yang mendasarinya:** [`PROBE.md`](./PROBE.md)

## Menjalankan

```bash
npx tsx src/main.ts [flag apa pun untuk claude]

# contoh nyata:
npx tsx src/main.ts --dangerously-skip-permissions \
  --dangerously-load-development-channels "plugin:cc-plugin@mirza-bots"
```

**Node, bukan Bun.** `pty.write()` gagal di Bun 1.3.11 dengan
`ERR_SOCKET_CLOSED`; Node v22 bekerja. Test tetap `bun test` — seluruh logika
ada di modul murni yang tidak menyentuh `node-pty`.

Seluruh argumen diteruskan **apa adanya** ke `claude`. Wrapper tidak
berpendapat soal flag CC, sama seperti ia tidak berpendapat soal command mana
yang boleh disuntik: itu kebijakan, dan kebijakan tinggal di lapisan atas.

## Cara memberi perintah

Jatuhkan berkas JSON ke `<botHome>/slash/`:

Terpisah dari `<botHome>/inbox/` dengan sengaja: wrapper menghapus berkas
SEBELUM mem-parse-nya, jadi folder bersama membuatnya menelan pesan antar-bot
tanpa gejala apa pun -- jangan digabung lagi.

| Bentuk | Artinya |
|---|---|
| `{"command": "/rename x"}` | satu perintah |
| `[{"command":"/clear"},{"command":"/rename x"}]` | batch — dienqueue berdampingan, tidak bisa disela |
| `{"command":"/effort high","confirmAfterMs":500}` | perintah + Enter kedua untuk picker konfirmasi |

Tulis **atomik** (`.tmp` lalu rename): wrapper membaca folder ini dengan
polling, dan berkas setengah tertulis ditolak sebagai JSON rusak.

## Peta modul

| Berkas | Isinya | Murni? |
|---|---|---|
| `src/typer.ts` | Rencana pengetikan: jeda ketik→Enter, potong teks panjang, Enter kedua | ✅ |
| `src/queue.ts` | Antrean FIFO + gerbang jarak-minimum antar-**pengirim** | ✅ |
| `src/registry.ts` | Perlakuan khusus per-command, berbentuk data | ✅ |
| `src/inbox.ts` | Parsing payload `slash/` | ✅ |
| `src/lock.ts` | Satu wrapper per folder | ✅ |
| `src/startup.ts` | `--continue` + fallback, deteksi gerbang kepercayaan folder | ✅ |
| `src/shutdown.ts` | Mengenali pemilik yang hilang, mematikan PTY tanpa melempar | ✅ |
| `src/pty.ts` | **Satu-satunya** yang menyentuh `node-pty` | ❌ |
| `src/main.ts` | Perakitan | ❌ |

Pembagian itu bukan kerapian: `main.ts` men-spawn CC saat di-import, jadi apa
pun yang ada di dalamnya tidak bisa dimuat di dalam test. Semua yang bisa
diputuskan tanpa terminal diputuskan di modul murni — itu sebabnya 79 test
berjalan tanpa satu pun terminal.

## Empat perilaku yang mungkin mengejutkan

**1. Wrapper kedua di folder yang sama ditolak, bukan mengambil alih.**
Kebalikan dari `cc-plugin/src/engine/lock.ts` yang membunuh pemegang lama.
Aturannya sama — lindungi yang paling mahal kalau hilang — tapi yang mahal
berbeda: poller murah dilahirkan ulang, sesi CC hidup yang sedang bekerja
tidak. Lock yang PID-nya sudah mati **diambil alih**, jadi crash tidak
mengunci folder selamanya.

**2. Folder yang belum dipercaya akan menahan CC, dan wrapper hanya melapor.**
Gerbang `Quick safety check` muncul sebelum CC siap, dan
`--dangerously-skip-permissions` **tidak** melewatinya. Gerbangnya terbukti
bisa dilewati dengan menyuntik Enter — dan itu **sengaja tidak dilakukan**:
menyuntik Enter berarti memercayai sebuah folder atas nama user tanpa ia
melihat isinya. Jawab sekali dari keyboard, atau buka folder itu dengan
`claude` manual satu kali.

**3. `--continue` dipakai saat start, dengan satu percobaan ulang.**
Di folder tanpa sesi, CC menjawab `No conversation found to continue` lalu
keluar; wrapper menangkapnya dan spawn ulang tanpa flag itu. Syaratnya dua —
keluar cepat **dan** pesan itu — supaya kegagalan lain (binary tidak ketemu,
folder tidak ada) tidak tersembunyi di balik percobaan kedua.

**4. Wrapper bisa menutup sesinya sendiri kalau "pemilik"-nya hilang.**
Windows tidak mengirim apa pun ke anak saat induknya mati — tidak ada SIGHUP,
dan stdin pun **tidak** tertutup (diukur; lihat [`PROBE.md`](./PROBE.md) §Probe
ketiga). Akibatnya terminal yang crash meninggalkan `claude.exe` hidup selamanya,
memegang lock folder yang tidak bisa dilihat siapa pun.

Penawarnya: isi `CC_WRAPPER_OWNER_PID` dengan PID proses yang "memiliki" sesi
ini. Wrapper memeriksanya tiap detik dan menutup sesi setelah **dua** pembacaan
hilang berturut-turut (~2 detik) — diambangkan karena harga false positive di
sini adalah sesi kerja user.

```bash
CC_WRAPPER_OWNER_PID=$$ npx tsx src/main.ts     # POSIX
```
```cmd
rem Windows: mirza-bot.cmd mengisinya sendiri dengan shell pemanggil
```

**Tanpa variabel itu, fitur ini mati** — dan itu default yang disengaja: bot
yang sengaja dilepas dari terminal tidak boleh bunuh diri hanya karena tidak ada
yang mengaku memilikinya.

Batasnya jujur: `taskkill /F` pada wrapper tidak menjalankan kode apa pun, jadi
cucu-cucunya (MCP server) bisa tetap yatim. Jaminan penuh butuh Job Object.

## Test

```bash
bun test              # 79 test
bun run typecheck     # tsc --noEmit
```
