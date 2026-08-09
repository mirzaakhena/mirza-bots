# Spec — rule-id di `SERVER_INSTRUCTIONS` dan pencatatan pelanggaran

Tanggal keputusan: 2026-08-10. Berlaku untuk `mirza-bots/cc-plugin`.
Sesudah ini setiap aturan di `SERVER_INSTRUCTIONS` punya **nama**, dan dua penegak di `reply-guard` menyebut nama itu saat memblokir sekaligus mencatatnya.

---

## 1. Asal usul

Usul user 2026-08-09: menulis `SERVER_INSTRUCTIONS` sebagai `Rule #1`, `Rule #2`, … lalu membuat mesin menegur dengan kalimat semacam *"kamu sudah melanggar rule #n, ingat bahwasanya …"*, dan hanya untuk aturan yang memang bisa dideteksi mesin.

Idenya diterima; **bentuk nomornya ditolak**, dan cakupannya dipersempit. Alasan tiap penyimpangan ada di bagian 3.

---

## 2. Temuan yang melandasi spec ini

**T-1. Repo ini sudah punya lima bentuk penegakan, dan masing-masing dipilih sadar.**

| bentuk | tempatnya | contoh |
|---|---|---|
| ditolak di tool | `server.ts` | balasan antar-bot yang meminta balasan lagi |
| diblokir di Stop hook | `hooks/reply-guard.ts` | diam, dan prosa sesudah membalas |
| umpan balik di hasil tool | `formatSendResult` | `sent (1240 chars, over the 1000 guideline)` |
| pengingat keadaan | `engine/reminders.ts` | sesi belum bernama, context menumpuk |
| ditandai, bukan diblokir | engine | `reply` pada giliran antar-bot |

Yang ketiga paling murah dan paling kurang dihargai: ia datang di momen tindakan, tidak memakan giliran, dan tidak bernada menghakimi. Komentarnya sendiri menyebut alasannya — *"aturan yang tidak pernah membalas apa pun tidak bisa dipelajari"*.

**T-2. Lima dari enam aturan sudah punya penegak.** Penilaian awal ("cuma sedikit yang bisa dideteksi") keliru, dan dikoreksi setelah ditelusuri:

| aturan | penegaknya | bentuk |
|---|---|---|
| `reply-required` | Stop hook | blokir |
| `no-prose` | Stop hook | blokir |
| `reply-length` | hasil tool | umpan balik |
| `inter-bot-channel` | engine | ditandai |
| `expects-reply-only` | tool | ditolak |
| `ack-first` | **belum ada** | — |

Konsekuensinya untuk spec ini: kekhawatiran "aturan ber-id akan terbaca lebih wajib daripada yang tidak" jauh lebih kecil dari yang diduga, karena hampir semuanya ber-penegak.

**T-3. Hook tidak boleh mengimpor apa pun selain `node:`, dan itu terukur.** Versi pertama `hooks/session-start.ts` mengimpor modul engine "supaya tidak duplikasi", lalu **tidak pernah menyala** — sementara probe sebelumnya yang hanya mengimpor builtin `node:` menyala setiap kali. Jadi "satukan saja jadi satu import" bukan pilihan yang tersedia.

---

## 3. Keputusan

**K-1. Identitas sebuah aturan adalah NAMA, bukan nomor.**

`no-prose`, bukan `#3`.

*Alasan:* nomor bersifat posisional — `#3` berarti "yang ketiga dari atas". Menyisipkan aturan di tengah atau menghapus satu membuat seluruh rujukan `#3` di hook, test, dan komentar menunjuk aturan yang salah, **tanpa ada yang error**. Itu kelas kegagalan yang repo ini sudah punya doktrinnya (dua literal yang harus sama akan menyimpang diam-diam), dan `engine/reminders.ts` sudah memakai nama (`name-session`, `context-low`), jadi konvensinya tinggal dipakai konsisten.

*Efek samping yang bagus:* nama sudah menjelaskan dirinya. `` `no-prose` `` terbaca sebelum kalimat pengingatnya dibaca; `#3` tidak.

**K-2. Hanya blok yang benar-benar ATURAN yang mendapat id.**

Daftar sumbernya memuat dua jenis entri:

```ts
{ id: "no-prose", text: "..." }   // aturan  -> keluar sebagai "Rule no-prose: ..."
{ text: "..." }                    // penjelasan -> keluar apa adanya
```

*Alasan:* `SERVER_INSTRUCTIONS` sekarang berisi sepuluh paragraf, dan hanya **lima** di antaranya aturan — menjadi enam sesudah pemecahan di K-3, dari sebelas paragraf. Sisanya penjelasan: penanda menyebut sumber bukan perilaku, orangnya AFK, giliran yang diketik di terminal adalah giliran biasa, kenapa aturan antar-bot sengaja tidak diblokir, dan apa arti `[from: system]`. Melabeli penjelasan sebagai *Rule* adalah berbohong kepada pembacanya, dan pembacanya bertindak atas label itu.

*Konsekuensi yang diterima sadar:* daftarnya jadi punya dua bentuk entri, bukan satu. Harga itu dibayar untuk menghindari label yang salah.

**K-3. Paragraf terse-turn dipecah menjadi dua aturan.**

`reply-required` (semua yang mau dikatakan lewat `reply`) dan `no-prose` (jangan sekaligus menulis prosa; tutup dengan satu titik).

*Alasan:* `reply-guard` sudah lama memperlakukan keduanya sebagai **dua pelanggaran terpisah** dengan dua pesan berbeda. Teksnya yang tertinggal, bukan mesinnya. Satu id untuk dua kewajiban akan membuat catatan pelanggaran tidak bisa membedakan "diam" dari "boros" — dua kegagalan yang obatnya berlawanan.

**K-4. Hook mengeja rule-id sebagai literal, dan jaraknya ditutup oleh TEST.**

*Alasan:* impor dilarang (T-3), jadi salinan tidak terhindarkan. Yang bisa dipilih hanyalah salinan yang dijaga atau salinan yang tidak. Idiom ini sudah dipakai di repo untuk `AGENT_TURN_MARKER`.

*Kenapa bukan `rules.json` yang di-generate:* hook memang boleh `readFileSync`, jadi secara teknis bisa. Tapi yang dibutuhkan hook cuma **id**, bukan teks aturannya — teksnya sudah ada di context AI lewat `instructions`. Jadi permukaan yang diduplikasi hanya beberapa string pendek, terlalu murah untuk dibayar dengan artefak build yang bisa basi. Berkas hasil generate yang lupa di-generate ulang adalah persis bentuk kegagalan diam yang doktrin ini ada untuk mencegah, dan ia tetap butuh test penjaga — jadi ongkos test-nya sama, hanya artefaknya yang bertambah.

**K-5. Pesan teguran berisi ID + IMPERATIF, tanpa mengulang alasan.**

Bentuknya: nama aturan, lalu satu kalimat "apa yang harus dilakukan sekarang". Bukan pengulangan kenapa aturan itu ada.

*Alasan:* alasannya sudah dibayar sekali di `instructions`, yang dipegang Claude Code sepanjang sesi, dan masih ada di context AI saat teguran datang. Mengulangnya memindahkan biaya sekali-sesi menjadi biaya per-kejadian, sekaligus melahirkan salinan kedua dari kalimat yang bisa menyimpang dari aslinya.

*Konsekuensi yang diterima sadar:* pada sesi sangat panjang yang context-nya dipadatkan, teks aturan bisa bergeser jauh dari perhatian, dan teguran tanpa alasan jadi lebih tipis daripada teguran yang mengulang. Itu diterima: imperatifnya tetap utuh, dan yang dibutuhkan pada saat itu adalah tindakan, bukan pemahaman.

**K-6. Pelanggaran yang terdeteksi hook DICATAT ke `logs/violations.jsonl` di folder bot.**

Satu baris per pelanggaran: waktu, `session_id`, rule-id.

*Alasan:* tanpa pencatatan, seluruh perubahan ini kosmetik — id yang rapi tapi tidak menjawab satu pertanyaan pun yang belum bisa dijawab sekarang. Dengan pencatatan, "aturan mana yang paling sering dilanggar" dijawab angka, dan dari situ baru ketahuan apakah yang salah aturannya atau kalimatnya.

*Bentuknya mengikuti yang sudah ada:* `session-start.ts` sudah menulis `logs/session-hook.log` dengan pola yang sama, termasuk `try/catch` yang membuat pencatatan tidak pernah menjadi penyebab hook gagal.

**K-7. Pengingat pelanggaran TIDAK boleh masuk `engine/reminders.ts`.**

*Alasan:* berkas itu punya invarian yang ditetapkan user 2026-08-06 — **pemicunya keadaan, bukan peristiwa**. Konsekuensinya sengaja: tidak ada flag "sudah pernah diingatkan", tidak ada logika berhenti, dan pengingat lenyap sendiri begitu kondisinya tidak terpenuhi. "Sudah melanggar aturan X" adalah peristiwa; mengungkapkannya sebagai keadaan menuntut state "sudah melanggar dan belum diakui", yaitu tepat flag yang doktrin itu larang.

Tempatnya adalah **lapisan hook**, yang memang event-driven, dan `stop_hook_active` sudah menjadi mekanisme "paling banyak sekali per giliran" tanpa perlu menambah apa pun.

---

## 4. Test yang wajib ada

Ketiganya menjaga hal yang tanpanya tidak ada yang merah:

1. **Setiap rule-id yang dirujuk hook ada di daftar sumbernya.** Ini pengganti impor yang dilarang (K-4). Tanpa test ini, mengganti nama sebuah aturan membuat hook menyebut nama yang tidak lagi ada, dan tidak ada yang gagal.
2. **Id unik, dan setiap blok ber-id benar-benar muncul di `SERVER_INSTRUCTIONS`** sebagai `Rule <id>:`. Aturan yang punya id tapi tidak pernah sampai ke pembacanya adalah setengah kontrak — kegagalan yang persis sama bentuknya dengan `[from: system]` yang tidak pernah diperkenalkan (0.37.2).
3. **Pesan blokir `reply-guard` memuat id-nya**, bukan cuma prosa.

---

## 5. Batas yang diterima sadar

- **Yang tercatat hanya 2 dari 6 aturan** — `reply-required` dan `no-prose`. Tiga penegak lain hidup di proses lain (engine, tool) yang punya penyimpanan sendiri. Menyatukan seluruh catatan pelanggaran adalah keputusan kedua, dan sengaja tidak diselundupkan ke sini.
- **`ack-first` tetap tanpa penegak.** Bisa dideteksi dari transcript, tapi deteksi baru berarti false positive baru, dan bot yang ditegur untuk sesuatu yang tidak ia lakukan belajar hal yang salah. Ditunda sampai ada bukti ia benar-benar sering dilanggar.
- **`logs/violations.jsonl` tidak dibaca siapa pun pada tahap ini.** Ia menumpuk sampai ada yang menanyainya. Menambah pembaca berarti menambah keputusan tentang apa yang ditampilkan dan di mana, dan itu belum perlu.

---

## 6. Yang TIDAK dikerjakan

- Menomori aturan (K-1).
- Mengubah lima bentuk penegakan yang sudah ada menjadi satu bentuk seragam. Menyeragamkannya menjadi "kamu melanggar rule X" meruntuhkan lima register menjadi satu: omelan. Yang berubah hanya **label** yang dibawa tiap bentuk, bukan bentuknya.
- Memindahkan aturan apa pun dari `instructions` ke `reminders.ts` atau sebaliknya. Pembagiannya sudah dinyatakan di kepala `reminders.ts` dan tidak disentuh spec ini.
