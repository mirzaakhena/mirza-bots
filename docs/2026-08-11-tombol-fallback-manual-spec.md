# Spec — tombol fallback `✏️ Explain manually` yang diinjeksi mesin

Tanggal keputusan: 2026-08-11. Berlaku untuk `mirza-bots/cc-plugin`.
Sesudah ini setiap keyboard yang AI kirim lewat `reply` **selalu** berakhir dengan satu baris `✏️ Explain manually` yang ditempelkan kode, dan dua aturan bernama baru menjaga sisi yang tidak bisa ditempelkan kode.

---

## 1. Asal usul

Temuan user 2026-08-10, pada ujicoba `bot-01` sesudah migrasi ke sistem baru: tombol fallback "explain manually" — yang seharusnya selalu hadir sebagai pilihan **terakhir** di setiap keyboard, sebagai jalan keluar kalau semua pilihan yang ditawarkan tidak cocok — **tidak pernah muncul**. Ekspektasi user dinyatakan eksplisit: tombol itu diinjeksi **secara mekanis**.

Idenya diterima seluruhnya. Satu klarifikasi yang mengubah cara membacanya: di sistem lama pun ia belum pernah mekanis (T-2). Jadi spec ini **peningkatan**, bukan perbaikan regresi — dan itu penting, karena yang diperbaiki bukan kode yang rusak melainkan aturan yang selama ini tidak punya penegak.

---

## 2. Temuan yang melandasi spec ini

**T-1. Aturannya tidak ada di sistem baru — sama sekali.**

`grep "Explain manually"` di `cc-plugin` 0.43.0 menemukan dua tempat, keduanya **bukan** kode aktif:

| tempat | isinya |
|---|---|
| `src/engine/messages.ts:250` | komentar, menyebutnya "escape hatch" |
| `test/engine/messages.test.ts:386,391` | test bahwa tombol itu **tidak** memicu pagar narasi bernomor |

Artinya mesin baru cuma *tidak menghukum* tombol itu kalau ada. Ia tidak pernah membuatnya. Deskripsi tool `reply` di `server.ts` juga tidak menyebutnya, jadi AI tidak punya petunjuk apa pun.

**T-2. Di sistem lama pun ia BUKAN mekanis.**

`inline-buttons/skills/inline-buttons/SKILL.md:111` menyebutnya *"Self-check ritual: after composing a `buttons` array, look at its last row. If it is not the manual button, append it."* — instruksi ke AI, bukan kode. Kalimat berikutnya di berkas itu mengakui hasilnya sendiri: *"This is the single most forgotten rule in this skill."*

Jadi aturan ini sudah pernah gagal dalam bentuk instruksi, di sistem yang instruksinya masih hidup. Itu bukti langsung bahwa bentuk yang benar untuknya adalah kode.

**T-3. Menyalakan ulang skill lama bukan penawar.**

`inline-buttons@mirza-marketplace: false` di `bot-01/.claude/settings.json` — mati karena migrasi, bukan karena rusak. Tapi SKILL.md itu mengajarkan skema tombol lama: `callback_id` muncul 19×, `label` 20× (dihitung 2026-08-11), sementara tool `reply` baru menuntut `{text, data}`. Menyalakannya berarti menyalakan pengajar yang aktif mengajarkan bentuk yang **ditolak** pagar.

Sudah diprediksi di `docs/2026-08-10-migrasi-bot-06-spec.md:283-293`, lengkap dengan penawarnya: *"memindahkan aturannya ke sistem baru"*. Spec ini adalah pemindahan itu.

*Catatan ketelitian:* spec migrasi menyebut angka **33** untuk sebutan skema lama. Angka itu tidak berhasil direproduksi (19 + 20 = 39 dengan cara hitung paling wajar). Selisihnya tidak mengubah kesimpulan apa pun — dicatat supaya angka yang salah tidak diwarisi terus.

**T-4. Empat aturan BENTUK dari skill lama sudah naik kelas menjadi pagar.**

| aturan skill lama | penegaknya sekarang | bentuk |
|---|---|---|
| label angka butuh narasi bernomor | `findMissingButtonNarration` | ditolak sebelum kirim |
| `buttons` tidak boleh bareng `files` | `assertNoButtonsWithFiles` | ditolak sebelum kirim |
| keyboard hilang sesudah ditap | `buildTappedMessageEdit` | dilakukan mesin |
| batas `callback_data` | `findUnsafeButtonData` | ditolak sebelum kirim |

Konsekuensinya untuk spec ini: yang hilang dari migrasi **bukan** seluruh skill, hanya satu-satunya bagiannya yang belum pernah punya penegak.

**T-5. `callback_data` dilihat USER, bukan cuma mesin.**

`buildTappedMessageEdit` (`messages.ts:198`) menempelkan data mentahnya ke pesan yang ditap: `` `${message.text}\n\n→ ${callbackData}` ``. Komentar di atasnya menjelaskan kenapa data, bukan label: Telegram tidak mengirim label kembali bersama query, dan keyboard yang dikirim tidak pernah disimpan.

Terbukti pada uji hidup 2026-08-11: tap menghasilkan `→ manual` di layar user, bukan `→ ✏️ Jelaskan manual`. Temuan ini yang menentukan K-3.

**T-6. `buildInlineKeyboard` punya SATU pemanggil.**

`engine.ts:1065`, di dalam `sendOutgoing`. Menu milik lapisan slash (`/branch`, `/switch`) menyusun `inline_keyboard` literal sendiri di `engine.ts:644` dan `:771`, jadi mereka tidak lewat sana. Itu memberi scoping gratis: apa pun yang disuntikkan di titik itu hanya kena tombol AI.

**T-7. Kebiasaan menawarkan tombol pernah dimekanisasi, dan user membunuhnya.**

Aturan lamanya "diakhiri `?` → tombol, tanpa kecuali". Vonis user 2026-08-01, dikutip di `SKILL.md:28-29`: *"cukup mengganggu juga kalau setiap saat keluar buttons."* Menghidupkan detektor `?` berarti membatalkan keputusan yang sudah diambil dengan bukti.

**T-8. Bukti hidup dari sesi brainstorming spec ini sendiri.**

AI mengirim pertanyaan biner sebagai teks polos **dua kali** di dalam sesi yang seluruh isinya membahas tombol — ditangkap user, bukan oleh mesin. Ini menutup argumen "cukup diingatkan sekali": lupa terjadi di sesi yang paling sadar sekalipun.

---

## 3. Keputusan

**K-1. Injeksi hanya terjadi bila AI SUDAH menawarkan tombol.**

`buttons` kosong atau tidak ada → tidak ada yang ditempel.

*Alasan pertama, desain:* tombol fallback sendirian adalah keyboard yang menawarkan jalan keluar dari nol pilihan. Skill lama sudah melarangnya (`SKILL.md:180`: *"Open-ended questions get NO buttons. Do not bolt on a lone manual button 'just in case'"*), dan alasannya tetap berlaku — pertanyaan terbuka sudah bisa dijawab bebas tanpa tombol apa pun.

*Alasan kedua, mekanis, dan ini yang mengikat:* `assertNoButtonsWithFiles` melempar bila `buttons` **dan** `files` sama-sama terisi. Injeksi tanpa syarat akan membuat **setiap** `reply` yang mengirim berkas gagal. Jadi syarat ini bukan selera, ia keharusan.

**K-2. Titik injeksinya `engine.ts:1065`, lewat fungsi murni di `messages.ts`.**

```ts
const replyMarkup = buttons
  ? buildInlineKeyboard(withManualFallback(buttons))
  : undefined;
```

*Alasan:* `messages.ts` sudah menampung seluruh pagar tombol yang murni dan teruji tanpa bot. Penghuni baru duduk di kamar yang benar.

*Kenapa BUKAN di dalam `buildInlineKeyboard`:* hari ini hasilnya identik karena pemanggilnya cuma satu (T-6). Bedanya besok: pemanggil kedua akan kena injeksi tanpa penulisnya sadar. Dan nama fungsi itu berarti "ubah rows jadi keyboard" — menambah tombol di dalamnya membuat namanya berbohong.

*Kenapa BUKAN di dalam `prepareReply`:* untungnya nyata — pagar ikut memeriksa tombol injeksi. Tapi `prepareReply` mengembalikan `{parts, planned}`; supaya injeksinya terpakai ia harus mulai mengembalikan `buttons` juga, dan tanggung jawabnya melebar dari "pagar + potong teks" menjadi ikut **mengarang** tombol. Itu harga besar untuk jaminan yang sudah diberi test (bagian 4, nomor 7).

*Cabang `undefined` tidak disentuh,* sehingga jalur berkas tetap aman tanpa satu baris tambahan.

**K-3. Label pendek, data yang BICARA, keduanya English.**

```ts
export const MANUAL_FALLBACK_BUTTON = {
  text: "✏️ Explain manually",
  data: "let me explain manually instead",
} as const;
```

*Kenapa data-nya sepanjang itu:* T-5 membuktikan data dibaca **dua** pembaca — user di layar (`→ let me explain manually instead`) dan AI di context. Data bisu seperti `manual` gagal di dua-duanya: di layar ia terbaca seperti kebocoran internal, dan di context ia satu token tanpa arti begitu sesi berganti atau context dipadatkan. Ini terbukti langsung pada uji hidup 2026-08-11 — AI mengaku tahu artinya hanya karena ia sendiri yang mengirim tombolnya beberapa menit sebelumnya.

*Kenapa berbentuk "let me …", bukan "explain manually":* data mendarat di context **sebagai pesan user**. `explain manually` dari mulut user terbaca sebagai *perintah kepada AI untuk menjelaskan* — arahnya terbalik dari maksudnya. `let me explain manually instead` tidak bisa dibaca dua arah.

*Kenapa English, bukan Indonesia:* keputusan user 2026-08-11. Yang tidak diklaim sebagai alasan: bahwa Claude lebih patuh pada instruksi English — itu tidak terukur di repo ini dan tidak dipakai sebagai dasar.

*Panjangnya 31 byte,* jauh di bawah batas 64 byte `callback_data`.

**K-4. Tidak ada penerjemah, tidak ada special-case di handler tap.**

Data mendarat apa adanya. `engine.ts:864` tidak disentuh, tidak ada tabel pemetaan data → kalimat.

*Alasan:* K-3 memindahkan seluruh beban makna ke dalam string data itu sendiri. Penerjemah adalah kode yang ada hanya karena datanya bisu; begitu datanya bicara, ia jadi kode tanpa pekerjaan. Keputusan user 2026-08-11, dan ia menghapus satu komponen utuh dari desain sebelumnya.

**K-5. Fungsinya idempoten, dan dedupe berdasarkan `data`.**

```ts
export function withManualFallback(rows: ButtonRow[]): ButtonRow[]
```

1. `rows` kosong → kembalikan apa adanya (K-1).
2. `MANUAL_FALLBACK_BUTTON.data` sudah ada **di mana pun** di dalam `rows` → kembalikan apa adanya.
3. Selain itu → tambah satu baris baru di paling bawah, berisi satu tombol itu.

*Kenapa dedupe by `data`, bukan by label:* data adalah identitas yang stabil; label bisa berubah kapan saja tanpa mengubah arti tombolnya. Doktrin ini sudah dinyatakan skill lama (`SKILL.md:137`: *"labels can change; ids are stable"*).

*Kenapa "di mana pun", bukan "di baris terakhir":* memeriksa posisi menuntut keputusan kedua — apa yang dilakukan bila tombolnya ada tapi bukan di bawah: dipindahkan, atau dibiarkan. Memindahkan tombol yang AI tulis sendiri adalah mesin menyunting maksud AI, dan itu lebih besar dari yang dibutuhkan spec ini. *Konsekuensi yang diterima sadar:* bila AI menulis fallback sendiri di tengah keyboard, ia tetap di tengah. Aturan `buttons-when-pickable` sendiri melarang AI menulisnya, jadi jalur ini seharusnya tidak pernah terjadi — dedupe-nya adalah jaring, bukan jalan utama.

*Kenapa idempoten:* `withManualFallback(withManualFallback(x))` harus sama dengan `withManualFallback(x)`. Itu yang membuatnya aman dipanggil dari titik kedua kalau suatu hari ada.

**K-6. Kebiasaan menawarkan tombol menjadi DUA aturan bernama di `INSTRUCTION_BLOCKS`.**

Bukan satu. *Alasan:* doktrin K-3 spec 2026-08-10 — satu id untuk dua kewajiban membuat catatan pelanggaran tidak bisa membedakan dua kegagalan yang obatnya berlawanan. Di sini dua kegagalan itu adalah **lupa menawarkan** dan **salah merespons tap**.

Aturan 1 — `buttons-when-pickable`:

> Before sending a `reply`, ask one question about it: can the answer you want be picked from a short list? A confirmation where yes/no genuinely settles it, or a menu of 2–4 named options — both qualify, so attach `buttons`. Anything whose real answer is prose does not: an opinion, an explanation, a preference you cannot enumerate. A question mark is not the trigger, and flattening a real question into a false binary to earn a keyboard is worse than sending it as text. Keep labels short: for menus, narrate the options as a numbered list in the body and let the buttons be the bare numbers. Never write the escape-hatch button yourself — the engine appends it to every keyboard you send.

Aturan 2 — `manual-fallback-tap`:

> When `let me explain manually instead` arrives as the user's message, they tapped the escape hatch: the options you offered did not fit. Answer with a single `reply` carrying no buttons at all, inviting them to say it in their own words. That applies to THAT reply only — on the next turn, offer buttons again as usual under the rule above.

*Kalimat terakhir aturan 2 adalah keputusan user 2026-08-11,* atas kekhawatiran yang ia ajukan sendiri: kalimat "jangan kirim tombol lagi" tidak menyebut sampai kapan, dan AI yang menebak "seterusnya" akan mematikan fitur tombol pelan-pelan justru gara-gara tombol yang seharusnya sekali pakai. Cakupannya dipaku ke satu balasan.

*Kalimat terakhir aturan 1* — larangan menulis fallback sendiri — adalah pasangan K-5 nomor 2: mesin yang sudah menjamin kehadirannya membuat tulisan tangan AI jadi risiko kembar, bukan cadangan.

**K-7. Aturan itu TIDAK boleh masuk `engine/reminders.ts`.**

*Alasan:* berkas itu punya syarat masuk yang ditulis eksplisit di kepalanya (`reminders.ts:38`): **kapan ia TIDAK menyala?** Self-audit tombol menyala di setiap giliran, tanpa kecuali, jadi ia gagal ujian itu — dan dokumen yang sama menyatakan bahwa yang membunuh kanal `[from: system]` adalah ambang yang longgar, bukan jumlah penghuninya.

`INSTRUCTION_BLOCKS` adalah tempat untuk yang **selalu** berlaku dan dibayar sekali per sesi. Aturan ini selalu berlaku. Pembagian itu sudah dinyatakan di kepala `reminders.ts` dan spec ini tidak menyentuhnya.

**K-8. Cakupan sempit: keyboard yang dikirim TIDAK disimpan.**

Keputusan user 2026-08-11, sesudah alternatifnya disajikan.

Alternatif yang ditolak untuk sekarang: menyimpan keyboard saat dikirim (`conversations.db` sudah menyimpan pesan keluar), supaya tap bisa dilaporkan sebagai *"user menekan tombol berlabel X"* untuk **semua** tombol — memperbaiki kemunduran yang diakui komentar `messages.ts:194-196`, bukan hanya untuk tombol fallback.

*Alasan menolak sekarang:* ia menyentuh skema DB dan handler tap, dua permukaan yang tidak perlu disentuh untuk menyelesaikan keluhan yang memicu spec ini. Ia layak jadi spec sendiri, dan K-3 justru mengurangi urgensinya — data yang bicara sudah menutup sebagian besar kerugiannya.

---

## 4. Test yang wajib ada

Unit, di `test/engine/messages.test.ts` — fungsi murni, tanpa menyalakan bot:

1. `rows` kosong → kembali kosong, tidak ada injeksi.
2. Satu baris tombol → jadi dua baris; baris kedua berisi tepat satu tombol, yaitu fallback.
3. Fallback sudah ada di baris terakhir → tidak jadi kembar.
4. Fallback ada di baris **tengah** → juga tidak kembar (K-5, dedupe by presence).
5. Idempoten: dipanggil dua kali hasilnya identik.
6. `rows` masukan tidak dimutasi.

7. **`findUnsafeButtonData([[MANUAL_FALLBACK_BUTTON]])` harus `null`.**

Nomor 7 adalah pengganti pemeriksaan runtime, dan bentuknya penting: ia menjalankan **pagar yang sebenarnya**, bukan menyalin ambangnya. Menulis `expect(byteLength(data)).toBeLessThan(64)` melahirkan salinan kedua dari angka 64, yaitu persis kelas kegagalan yang doktrin repo ini larang — dua literal yang harus sama akan menyimpang diam-diam. Dengan bentuk ini, memperketat pagarnya membuat test ini ikut tahu.

Integrasi, di `test/engine/reply-outgoing.test.ts`:

8. `reply` dengan satu baris tombol → keyboard yang benar-benar dikirim ke Telegram punya fallback di baris terakhir. Nomor 1–7 **tidak** membuktikan ini: fungsi murni yang benar tapi tidak pernah dipanggil lolos semuanya.
9. `reply` dengan `files` dan tanpa `buttons` → tidak ada `reply_markup` sama sekali.

Aturan:

10. `RULE_IDS` memuat `buttons-when-pickable` dan `manual-fallback-tap`. Test yang sudah ada — yang mengadu id yang dieja hook dengan id yang benar-benar ada (`server.ts:222-233`) — harus tetap hijau.

Suntingan pada test yang sudah ada:

11. `test/engine/messages.test.ts:391` sekarang menulis `"✏️ Explain manually"` sebagai string mentah. Ia harus memakai `MANUAL_FALLBACK_BUTTON`. Tanpa itu, dua literal yang harus sama duduk di dua berkas dan bebas menyimpang — dan yang menyimpang di sini akan membuat test itu menjaga tombol yang sudah tidak ada.

---

## 5. Batas yang diterima sadar

- **`findUnsafeButtonData` tidak memeriksa tombol injeksi saat runtime.** Injeksi terjadi sesudah `prepareReply`, jadi yang menjaganya adalah test nomor 7, bukan pemeriksaan tiap kirim. Wajar: datanya konstanta milik kode sendiri, bukan masukan dari luar.
- **Injeksi menambah satu baris, dan batas jumlah baris Telegram tidak diverifikasi.** Skill lama mengklaim "max 8 baris × 8 tombol"; klaim itu **tidak** diuji ulang, dan pagar jumlah tombol per baris memang sengaja tidak dipasang (`docs/2026-08-10-review-temuan-perbaikan.md:96`). Yang diketahui pasti hanya batas 100 tombol per pesan. Risikonya kecil — butuh keyboard 8+ baris dalam satu balasan chat — dan bila terjadi ia **tidak diam**: Telegram menjawab 400 dan `sendOutgoing` sudah membungkusnya menjadi `reply failed after N of M parts sent`. Memasang pagar atas batas yang belum diukur hanya memindahkan tebakan ke dalam kode.
- **`buttons: []` tetap menghasilkan `reply_markup` kosong seperti hari ini.** Array kosong bersifat truthy di JS, jadi ternary di `:1065` tetap masuk; K-5 nomor 1 mengembalikannya apa adanya. Perilakunya tidak berubah, dan sengaja tidak diperbaiki di spec ini — itu keanehan yang sudah ada sebelumnya dan bukan bagian dari keluhan yang memicu spec ini.
- **`buttons-when-pickable` tidak punya penegak mesin, dan tidak akan punya.** T-7 menutup jalur itu dengan keputusan user yang berdasar bukti. Yang menjaganya hanya teks aturan di context — dan T-8 membuktikan itu bocor. Diterima sadar: yang bisa dijamin mesin sudah dijamin (baris terakhir), dan yang tersisa adalah penilaian yang memang milik AI.

---

## 6. Yang TIDAK dikerjakan

- **Menyimpan keyboard yang dikirim** supaya tap bisa dilaporkan berlabel (K-8). Spec terpisah.
- **Menyalakan ulang `inline-buttons@mirza-marketplace`** (T-3). Ia akan mengajarkan skema yang ditolak.
- **Menerjemahkan `data` menjadi kalimat di handler tap** (K-4). Dihapus dari desain, bukan ditunda.
- **Pagar jumlah tombol per baris atau per keyboard.** Batasnya belum diukur (bagian 5).
- **Memindahkan aturan apa pun antara `INSTRUCTION_BLOCKS` dan `reminders.ts`** selain menambah dua penghuni baru di yang pertama (K-7).
- **Menyentuh keyboard milik lapisan slash** (`engine.ts:644`, `:771`). Tombol "explain manually" di daftar sesi tidak berarti apa-apa.
