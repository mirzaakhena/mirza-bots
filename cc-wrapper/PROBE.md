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

## Cara mengulang

```bash
cd C:/Users/Mirza/workspace/mirza-bots/cc-wrapper
bun run probe/spawn-probe.ts      # diharapkan gagal di pty.write
npx tsx probe/spawn-probe.ts      # diharapkan berhasil
```

Probe tidak mencerminkan keluaran PTY ke stdout (menyimpang dari rencana):
menjalankannya dari dalam sesi CC lain membuat escape sequence TUI membanjiri
dan menutupi hasilnya. Ringkasan dicetak; aliran bersih disimpan ke berkas.
