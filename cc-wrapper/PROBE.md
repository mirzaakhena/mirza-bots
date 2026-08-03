# PROBE — Task 0: runtime dan `node-pty`

**Tanggal:** 2026-08-03 · **Mesin:** Windows 11 Home 10.0.26200 (win32 x64)
**Rencana:** `mirza-marketplace/docs/superpowers/plans/2026-08-03-cc-wrapper-fondasi.md`

Task 0 sengaja tidak menulis kode produk. Seluruh rencana berdiri di atas
asumsi bahwa `node-pty` bisa menjalankan Claude Code di mesin ini — dan wrapper
lama memakai `tsx` (Node) untuk `wrapper.ts` sementara `cc-plugin` seluruhnya
Bun. Perbedaan itu belum pernah diuji ulang.

## Hasil

| Runtime | Spawn | Byte sesudah boot | `pty.write()` | `/clear` terlihat | Galat |
|---|---|---|---|---|---|
| **Bun 1.3.11** | ✅ ok (pid 25808) | 2251 | ❌ **gagal** | — | `ERR_SOCKET_CLOSED` — `Socket is closed` di `windowsTerminal.js:147` |
| **Node v22.20.0** (via `tsx` 4.23.5) | ✅ ok (pid 38900) | 2251 | ✅ ok | ✅ **YA** | — |

Keduanya **berhasil spawn** dan menangkap jumlah byte boot yang identik (2251),
jadi kegagalannya bukan pada pemuatan native binding maupun pada spawn — murni
pada **penulisan** ke PTY.

## Keputusan

> **Runtime produksi cc-wrapper adalah Node + `tsx`, bukan Bun** — karena
> `pty.write()` gagal di Bun dengan `ERR_SOCKET_CLOSED`, dan menulis ke PTY
> adalah seluruh alasan paket ini ada.

Konsekuensi yang diterima sadar: repo ini jadi memakai **dua runtime**
(`cc-plugin` di Bun, `cc-wrapper` di Node). Itu harga yang lebih murah daripada
wrapper yang tidak bisa mengetik.

**Test tetap memakai `bun test`.** Seluruh logika ada di modul murni yang tidak
menyentuh `node-pty`, jadi runner test tidak perlu ikut pindah. Hanya `pty.ts`
dan `main.ts` yang butuh Node.

Bukti ini juga menjelaskan kenapa wrapper lama memakai `tsx` untuk
`wrapper.ts` sementara skrip demonya (`interactive`, `auto-clear`) punya varian
Bun: yang demo hanya membaca aliran, yang produksi menulis ke dalamnya.

## Yang terlihat di aliran — dan satu temuan yang tidak ada di rencana

Aliran mentah yang bersih tersimpan di `probe-out-node.txt`. Tiga hal
terkonfirmasi:

1. **Claude Code v2.1.220 boot penuh di dalam PTY** — banner, tips, dan baris
   status terender normal.
2. **Picker autocomplete memang muncul** saat `/clear` diketik: daftarnya
   menampilkan `/clear` dan `/telegram:name-session`. Ini pembenaran langsung
   untuk `SUBMIT_DELAY_MS` — menulis `teks + \r` sebagai satu tulisan akan
   membuat picker itu menelan Enter-nya.
3. **Enter diterima sebagai submit**: sesudahnya CC menampilkan `✢ Nucleating…`.

### ⚠️ Temuan: sesi anak mewarisi `CLAUDE_CODE_CHILD_SESSION`

Baris peringatan di aliran:

```
⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
```

Probe dijalankan dari dalam sesi Claude Code lain, dan CC anak **mewarisi
penanda itu lewat environment** — akibatnya **transcript-nya tidak disimpan**.

Ini bukan sekadar gangguan kosmetik. Rencana Lapis 3 bergantung pada file sesi
`.jsonl` dan hook `SessionStart` sebagai sumber bukti; sesi yang tidak menyimpan
transcript **tidak menghasilkan bukti itu**. Wrapper yang dijalankan dari dalam
sesi CC lain akan diam-diam kehilangan seluruh mekanisme post-check-nya.

**Yang harus dilakukan implementasi:** bersihkan environment sebelum spawn —
minimal buang `CLAUDE_CODE_CHILD_SESSION` — dan **verifikasi** peringatan itu
hilang, jangan diasumsikan.

**Yang belum diukur:** variabel `CLAUDE_CODE_*` lain apa saja yang ikut terwaris
dan berpengaruh. Probe ini hanya menemukan satu karena satu itu yang berteriak.

---

# Probe kedua — `--continue` dan gerbang kepercayaan folder

**Tanggal:** 2026-08-03 · **Berkas:** `probe/continue-probe.ts`, `probe/trust-probe.ts`

User mengusulkan `--continue` menggantikan `--resume <id>` supaya wrapper tidak
perlu tahu di mana CC menyimpan berkas sesi. Sebelum menulis kodenya, satu
pertanyaan harus dijawab: **apa yang terjadi kalau `--continue` dipakai di
folder yang belum punya sesi?** Itu keadaan pertama setiap bot baru.

## Hasil 1 — `--continue` menolak start di folder tanpa sesi

```
No conversation found to continue
```

Lalu prosesnya **keluar**. Bukan memulai sesi baru — benar-benar tidak start.

**Konsekuensi:** `--continue` tidak boleh dipakai buta. Jawabannya: coba
`--continue`; kalau CC keluar cepat **dan** mengatakan kalimat itu, spawn ulang
tanpa flag tersebut. Wrapper tetap tidak perlu tahu apa pun soal layout
internal CC — bedanya, yang lama **menebak dari mtime**, yang ini **bertanya
dan mendengarkan jawabannya**.

Syarat "dan mengatakan kalimat itu" penting: kegagalan lain (binary tidak
ketemu, folder tidak ada) tidak boleh memicu percobaan ulang, karena mengulang
akan menyembunyikan sebabnya di balik kegagalan kedua yang berbeda bentuk.

## Hasil 2 — gerbang kepercayaan folder menahan CC sebelum siap

Folder yang belum pernah dipercaya memunculkan:

```
Quick safety check: Is this a project you created or one you trust?
  ❯ 1. Yes, I trust this folder
    2. No, exit
  Enter to confirm · Esc to cancel
```

**`--dangerously-skip-permissions` TIDAK melewatinya** — diuji langsung.

Ini serius bagi wrapper: sesi tertahan di gerbang **tidak pernah siap**, dan
apa pun yang disuntik selama itu hilang atau terbaca sebagai pilihan menu.
Gejalanya menyesatkan — wrapper tampak berjalan, bot diam saja.

Terbukti juga bahwa gerbangnya **bisa** dilewati dengan menyuntik Enter
(pilihan "Yes" sudah tersorot). **Tapi itu tidak dilakukan.** Menyuntik Enter
berarti memercayai sebuah folder atas nama user tanpa ia melihat isinya —
keputusan keamanan, bukan keputusan teknis. **Keputusan user 2026-08-03:
deteksi dan lapor.** Jangan diam-diam diubah jadi melewati otomatis.

## Catatan bentuk keluaran — kenapa deteksinya menormalkan spasi

Keluaran TUI datang **tanpa spasi** karena dirender per kolom:
`Quicksafetycheck:Isthisaprojectyoucreated…`. Pencocokan yang mengandalkan
spasi akan meleset. `startup.ts` membuang escape sequence **dan** seluruh
whitespace sebelum mencocokkan.

## Yang BELUM diuji hidup

- **Jalur fallback `--continue`** — butuh folder yang sudah dipercaya **tapi
  belum punya sesi**, dan membuat keadaan itu berarti memercayai folder atas
  nama user. Yang ada baru unit test-nya (4 test di `test/startup.test.ts`).
- **Penolakan lock** sudah diuji hidup ✅ (PID `explorer.exe` dipakai sebagai
  pemegang; wrapper kedua keluar dengan kode 1 **tanpa men-spawn CC**).
- **Deteksi gerbang trust** sudah diuji hidup ✅ — pesannya muncul persis
  seperti dirancang saat wrapper diarahkan ke folder temp yang baru.

## Cara mengulang

```bash
cd C:/Users/Mirza/workspace/mirza-bots/cc-wrapper
bun run probe/spawn-probe.ts      # diharapkan gagal di pty.write
npx tsx probe/spawn-probe.ts      # diharapkan berhasil

# --continue di folder kosong (diharapkan: "No conversation found to continue")
npx tsx probe/trust-probe.ts "<folder-baru>" --continue --dangerously-skip-permissions
```

Probe tidak mencerminkan keluaran PTY ke stdout (menyimpang dari rencana):
menjalankannya dari dalam sesi CC lain membuat escape sequence TUI membanjiri
dan menutupi hasilnya. Ringkasan dicetak; aliran bersih disimpan ke berkas.
