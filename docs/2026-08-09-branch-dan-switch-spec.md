# Spec — `/branch` dan `/switch` untuk lapisan slash Telegram

Tanggal keputusan: 2026-08-09. Berlaku untuk `mirza-bots/cc-plugin`.
Sesudah ini lapisan slash Telegram punya lima command: `/context`, `/new`, `/rename`, `/branch`, `/switch`.

---

## 1. Temuan yang melandasi spec ini

Uji terkendali 2026-08-09, lima sel, dua bot yang di-reset lebih dulu (nol transcript, tanpa `session.id`/`status.json`). Jejak lengkapnya di `branch-probe-log.md`.

| sel | isi percakapan | sesi bernama | `/branch` dipanggil dari | nama sesudah branch |
|---|---|---|---|---|
| A1 | Telegram | tidak | Telegram | `Branched conversation (Branch)` |
| A2✗ | Telegram | tidak | Telegram | `/clear (Branch)` |
| A2 | Telegram | tidak | **terminal** | `/clear (Branch 2)` |
| A3 | Telegram | **ya** (`uji-a3`) | Telegram | `/clear (Branch 3)` |
| B1 | **terminal** | tidak | Telegram | `halo uji B1 (Branch)` |

**Kesimpulan:** Claude Code menamai branch dari **prompt yang diketik user ke TUI**. Pesan Telegram masuk sebagai channel notification dan tidak dihitung sebagai prompt, jadi di bot yang digerakkan Telegram tidak pernah ada bahan penamaan — CC jatuh ke teks paling depan yang kebetulan ada (echo `/clear`, atau `Branched conversation` kalau sesinya sendiri lahir dari branch).

Tiga tersangka lain gugur oleh data:
- **jalur pemanggilan** — A2 vs A2✗ berkondisi identik dan menghasilkan nama dasar yang sama, cuma nomornya naik. Terminal dan Telegram berperilaku persis sama.
- **`/rename`** — A3 bernama `uji-a3`, hasilnya tetap `/clear (Branch 3)`. Nama custom tidak pernah dilihat.
- **`/clear`** — A1 tidak punya `/clear` sama sekali dan tetap menghasilkan nama sampah.

Ini perilaku Claude Code, bukan bug `mirza-bots`, dan tidak ada yang bisa diperbaiki dari sisi repo. Yang bisa dilakukan lapisan Telegram hanyalah **memastikan nama selalu diberikan**.

---

## 2. Keputusan

**K-1. Membuat cabang WAJIB menyertakan nama; `/branch` polos menjawab dengan pohon sesi.**

`/branch <nama>` diteruskan ke Claude Code. `/branch` polos **tidak pernah** sampai ke CC — ia dijawab lapisan Telegram dengan gambar pohon sesi, ditutup satu baris petunjuk `Buat cabang: /branch <nama>`.

*Alasan wajib bernama:* satu-satunya bentuk yang menghasilkan nama bermakna adalah `/branch <nama>` (terverifikasi). Mewajibkannya menghapus empat mekanisme yang kalau tidak, harus dibangun dan diuji hanya untuk menebak nama yang user sudah tahu: membaca nama induk, menghitung anak lewat `forkedFrom`, menormalkan akhiran `(Branch n)` supaya tidak menumpuk, dan menangani tabrakan nama.

*Alasan bentuk polos menjawab pohon, bukan memarahi:* "saya di mana, dan ada cabang apa saja?" justru pertanyaan yang paling sering muncul tepat saat orang mengetik `/branch`. Pesan error mengubah pertanyaan itu jadi jalan buntu; pohon menjawabnya sekaligus menunjukkan nama-nama yang sudah dipakai — yang persis dibutuhkan untuk memilih nama berikutnya.

*Konsekuensi yang diterima sadar:* perilaku bawaan `/branch` milik CC tidak lagi bisa dicapai dari Telegram. Perilaku itu justru yang menghasilkan `/clear (Branch 4)`, jadi yang hilang tidak berharga.

**K-2. Nama yang kembar TIDAK ditolak; pembeda diletakkan di tampilan.** *(diubah 2026-08-10, menggantikan keputusan sebaliknya pada 2026-08-09)*

`/branch <nama>` diteruskan apa adanya walau ada sesi lain bernama sama. Yang kembar diberi id pendek di daftar detail — hanya yang kembar, supaya nama yang unik tetap bersih.

*Alasan perubahan:* identitas sesi adalah `session_id`; nama cuma label. Sejak tombol pindah membawa UUID utuh (K-7), nama kembar tidak pernah bisa menyesatkan mesin — tap nomor 3 pindah ke id yang persis itu. Yang tersisa hanya menyesatkan mata, dan itu masalah tampilan, bukan alasan melarang.

*Efek samping yang bagus:* pagar bentrok adalah satu-satunya alasan lapisan slash membaca disk saat user mengetik `/branch <nama>`. Menghapusnya membuat cabang itu murni lagi.

**K-3. Validasi nama memakai `validateSessionName` yang sudah ada.** Satu aturan nama untuk `/rename`, `/new`, dan `/branch` — tiga pintu tidak boleh berbeda pendapat soal nama yang sah.

**K-4. `/switch` menyuntik `/resume <sessionId>`, bukan tipe payload baru.** `/resume` sudah lolos lapisan slash hari ini (bahkan disebut eksplisit oleh `send_slash` sebagai pengganti `/switch`), jadi bagian paling berisiko dari fitur lama tidak perlu dibawa.

**K-6. Pohon dibatasi 19 kolom; bentuk dan detail dipisah.**

Diukur langsung di HP user 2026-08-09: **Telegram tidak punya scroll horizontal** — blok kode dibungkus. Begitu satu baris dibungkus, garis `├ │ └` kehilangan kolomnya dan anak tampak menempel pada induk yang salah. Pohon yang salah lebih buruk daripada pohon yang terpotong.

Lebar terpakai terukur: ~28 kolom pada font kecil, **~19 pada font besar**. Yang dipakai yang besar — tampilan tidak boleh rusak hanya karena pembaca memperbesar hurufnya.

19 kolom habis oleh indentasi + nama saja, jadi: **blok kode mengurus bentuk, daftar bernomor di bawahnya mengurus detail** (nama penuh, umur, penanda sesi aktif). Keduanya memakai urutan yang sama, sehingga nomor di daftar menunjuk baris yang sama di pohon.

**K-7. `/branch` polos menampilkan SILSILAH sesi berjalan saja, dengan tombol pindah di bawahnya.**

Naik lewat `forkedFrom` sampai leluhur paling atas, lalu turunkan seluruh keturunannya. Sesi lain di project ini tidak ikut. Di bawah pohon dipasang tombol angka; tap → `/resume <id>`.

*Alasan:* `/branch` menjawab "saya di mana, dan cabang apa saja yang serumpun". Daftar sesi yang tidak berhubungan memanjangkan layar tanpa menjawab pertanyaan itu — terlihat 2026-08-10, sepuluh sesi sudah mendorong baris `Buat cabang:` keluar layar. Tombolnya menutup jarak antara "melihat" dan "pindah", yang selama ini butuh dua perintah terpisah.

*Batas yang disadari:* tombol hanya untuk sesi LAIN. Tombol yang tidak melakukan apa-apa mengajari user bahwa tombol di sini boleh tidak berarti.

**K-8. `/switch` menampilkan sesi lintas silsilah, beberapa yang terbaru saja.**

Pembagian perannya jadi tegas: `/branch` = dalam satu rumpun, `/switch` = antar rumpun. Belum diimplementasikan.

**K-5. `/switch` melayani sesi apa pun asal-usulnya.** Sesi dari `/clear` dan dari `/branch` sama-sama berkas `.jsonl` di folder project yang sama; tidak ada pembedaan.

---

## 3. Fondasi bersama — `sessions.ts`

Modul **murni**: baca folder, kembalikan data. Tidak menulis, tidak menyentuh Telegram, bisa diuji tanpa menyalakan apa pun.

```
type SessionInfo = {
  id: string            // UUID, dari nama berkas
  title: string | null  // customTitle terakhir; null = belum pernah /rename
  mtime: number
  forkedFrom: { sessionId: string; messageUuid: string } | null
}
```

Sumbernya `~/.claude/projects/<encoded>/*.jsonl`. **Direktorinya dibaca dari `transcript_path` di `status.json`, tidak dihitung sendiri** — encoding nama folder milik CC tidak boleh ditebak (wrapper lama menebaknya dan pecah diam-diam saat CC mengubahnya).

`forkedFrom` adalah field asli Claude Code, terverifikasi ada:

```json
"forkedFrom": { "sessionId": "d786c019-…", "messageUuid": "ffd6d931-…" }
```

Ia memuat induk **dan titik pesan tempat percabangan diambil**, jadi graph riwayat branch bisa direkonstruksi utuh. Belum dipakai oleh K-1..K-5 mana pun, tapi dicatat di tipe karena ia gratis saat berkasnya sudah dibaca — dan ia satu-satunya jalan ke fitur "kembali ke induk" nanti.

**Dipakai dua tingkat:** `/branch` cuma butuh kumpulan `title` (untuk K-2); `/switch` butuh semuanya.

---

## 4. `/branch` — perilaku

| masukan | hasil |
|---|---|
| `/branch` | ditolak: "Sebutkan nama sesinya. Contoh: `/branch riset-api`" |
| `/branch <nama tidak sah>` | ditolak dengan pesan dari `validateSessionName` |
| `/branch <nama sudah dipakai>` | ditolak: nama itu sudah dipakai sesi lain |
| `/branch <nama sah & unik>` | diteruskan sebagai `/branch <nama>`, ack `🌿 Branch baru: \`<nama>\`` |

Masuk `KNOWN_COMMANDS` sehingga ikut muncul di menu `/` Telegram, dan validasinya jalan **sebelum** apa pun sampai ke TUI.

---

## 5. `/switch` — perilaku

1. picker terpaginasi dari `sessions.ts`, urut **mtime** terbaru dulu
2. label = `title` kalau ada, kalau tidak `session <8hex> · 5m`
3. **sesi yang sedang aktif dikecualikan**, dan dicek ulang saat tap dikonfirmasi
4. tap → kirim `/resume <sessionId>` lewat jalur slash biasa
5. tanpa sesi lain → jawab apa adanya, jangan tampilkan picker kosong

Batas yang sudah ada dan tetap berlaku: `callback_data` maksimum 55 byte sesudah prefiks (`confirmFits`). `session:<8hex>` muat dengan lega.

---

## 6. Urutan pengerjaan

1. **`sessions.ts`** + test — fondasi bersama. Dibangun sekali supaya `/branch` dan `/switch` tidak bisa berbeda pendapat soal "sesi apa saja yang ada".
2. **`/branch`** — kecil: satu entri `mapKnown`, validasi, cek bentrok.
3. **`/switch`** — paling besar: picker terpaginasi belum ada sama sekali di `mirza-bots`.

## 7. Yang belum diuji dan sebaiknya diuji sebelum bagian 3 ditulis

- Apakah `/resume <id>` yang disuntik ke PTY hidup benar-benar berpindah sesi, dan apakah `session.id` serta pengumuman "Sesi sekarang" ikut menyesuaikan.
- Apakah `forkedFrom` juga ditulis saat branch dilakukan **dengan nama** (`/branch foo`) — sejauh ini ia baru terlihat pada branch tanpa nama.


---

## 8. Status implementasi

- **cc-plugin 0.36.0** — `sessions.ts`, `branch-tree.ts`, `/branch` (dua cabang: pohon silsilah & bernama), tombol pindah sesi (`/resume <id>`), dan disambiguasi nama kembar selesai. 650 test hijau, `bunx tsc --noEmit` bersih.
- **`/switch`** — belum dikerjakan. Ia menunggu picker terpaginasi, komponen yang belum ada sama sekali di repo ini, dan dua ujicoba di bagian 7.
