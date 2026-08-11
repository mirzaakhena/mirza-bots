# Spec — tombol fallback `✏️ Explain manually` yang diinjeksi mesin

Tanggal keputusan: 2026-08-11. Berlaku untuk `mirza-bots/cc-plugin`.
Sesudah ini setiap keyboard yang AI kirim lewat `reply` **selalu** berakhir dengan satu baris `✏️ Explain manually` yang ditempelkan kode. Sisi yang tidak bisa ditempelkan kode — kebiasaan **menawarkan** tombol — dijaga dua aturan bernama baru plus satu hook yang menyuntik ulang kewajibannya setiap giliran.

Tiga lapisan, dan pembagiannya adalah inti spec ini: mesin menjamin baris terakhir (K-1..K-5), teks aturan mengajarkan kapan menawarkan (K-6..K-7), dan hook menaruh aturan itu di depan mata pada giliran ia dibutuhkan (K-9). Tidak ada satu pun yang memblokir.

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

**T-8. Bukti hidup dari sesi brainstorming spec ini sendiri — tiga kejadian.**

AI mengirim pertanyaan yang jawabannya bisa dipilih dari daftar pendek sebagai **teks polos**, tiga kali, di dalam sesi yang seluruh isinya membahas tombol. Ketiganya ditangkap **user**, tidak satu pun oleh mesin.

| # | pertanyaannya | diakhiri `?` |
|---|---|---|
| 1 | *"Mau aku tulis spec-nya dulu, atau kita putuskan ketiga ini di chat lalu langsung kerja?"* | ya |
| 2 | *"Setuju, atau mau semuanya Indonesia dengan penanda?"* | ya |
| 3 | *"Kalau ada yang mau diubah, bilang — kalau sudah oke, aku lanjut bikin implementation plan."* | **tidak** |

Ini menutup argumen "cukup diingatkan sekali": lupa terjadi di sesi yang paling sadar sekalipun.

**Polanya, dan ini yang berguna:** ketiganya muncul saat pertanyaan menempel di **ekor** giliran yang pekerjaan utamanya hal lain — memutuskan urutan kerja, menutup pembahasan bahasa, melaporkan commit. Tombol diingat ketika pertanyaannya **adalah** pekerjaan giliran itu; ia terlupa ketika pertanyaannya cuma penutup. Yang bocor bukan pengetahuannya, melainkan perhatiannya — dan justru di giliran yang paling padat, yaitu giliran yang paling jauh dari `instructions` yang dibaca sekali di awal sesi.

**Dan satu angka yang MENGGUGURKAN satu rancangan:** dari tiga kejadian, hanya **dua** yang diakhiri tanda tanya. Rancangan pertama K-9 adalah detektor `?` di hasil tool; angka itu memberinya jangkauan 2 dari 3 pada data nyata. Kejadian ke-3 lolos karena pertanyaannya ditulis sebagai **kalimat berita** — *"kalau ada yang mau diubah, bilang"* — dan tidak ada pola yang mengenali bentuk itu tanpa mengenali maksud. K-9 versi final tidak memakai detektor sama sekali.

**T-9. Sistem lama sudah memecahkan justru bagian yang T-8 keluhkan, dengan bentuk yang belum pernah dipertimbangkan spec ini.**

`plugins/telegram/hooks/telegram-turn-reminder.ts`, terdaftar sebagai `UserPromptSubmit` di `hooks.json`-nya, menyuntik ulang kewajiban kanal **setiap giliran** — termasuk barisnya sendiri untuk tombol:

> `- inline-buttons: if your reply asks a question or offers options, attach buttons (min Yes/No + a manual-fallback).`

Docstring berkas itu menyebut alasannya, dan kalimatnya mendiagnosis T-8 kata per kata tanpa pernah tahu T-8 ada: *"re-injects the ambient Telegram-channel obligations every turn (not just at SessionStart), **so they don't fade under task pressure**."*

Dua hal yang membuat temuan ini mengikat:

1. **MCP `instructions` sistem lama tidak menyebut tombol sama sekali** (12 blok, diperiksa 2026-08-11). Jadi penempatan aturan tombol di hook per-giliran adalah pilihan **sadar** perancangnya — bukan kelalaian yang kebetulan menolong.
2. **Sistem baru kehilangan slot itu, bukan mekanismenya.** `cc-plugin/hooks/hooks.json` mendaftarkan `SessionStart` + `Stop`; pendahulunya mendaftarkan `SessionStart` + **`UserPromptSubmit`** + `Stop`. Dan mekanismenya terbukti hidup di sistem baru: sesi ini menerima suntikan `UserPromptSubmit` milik user sendiri di setiap giliran. Tidak ada mesin baru yang perlu dibangun.

**T-10. Label tombol yang ditap bisa dipulihkan TANPA penyimpanan apa pun.**

Komentar `messages.ts:194-196` menyimpulkan *"the data is the only truthful thing we have to show here"* karena Telegram tidak mengirim label sebagai field tersendiri. Kesimpulan itu **salah**, dan sistem lama membuktikannya: `plugins/telegram/server.ts:1366` membaca `ctx.callbackQuery.message.reply_markup.inline_keyboard`, lalu `findButtonLabel` (`buttons.ts:111`) mencocokkan `callback_data` untuk mendapatkan `text`-nya. Keyboard-nya ikut kembali, menempel pada `message`.

Sistem baru **sudah memegang objek itu**: `engine.ts:922` menyerahkan `ctx.callbackQuery.message` ke `buildTappedMessageEdit`. `reply_markup`-nya ada di tangan dan tidak dibaca.

Konsekuensinya langsung ke K-8: ongkos alternatif yang ditolak di sana bukan "skema DB", melainkan satu fungsi murni belasan baris. Lihat catatan revisi di K-8.

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

*Alasan menolak sekarang:* ia menyentuh handler tap, permukaan yang tidak perlu disentuh untuk menyelesaikan keluhan yang memicu spec ini. Ia layak jadi spec sendiri, dan K-3 justru mengurangi urgensinya — data yang bicara sudah menutup sebagian besar kerugiannya.

*REVISI ONGKOS, 2026-08-11 — dan ini koreksi atas angka yang salah dilaporkan, bukan perubahan keputusan.* Alternatif ini disajikan sebagai "menyentuh skema DB", dan user memilih menolaknya atas dasar itu. T-10 kemudian membuktikan ongkos itu keliru: label tombol yang ditap **tidak perlu disimpan** sama sekali, karena Telegram mengirim balik keyboard-nya menempel pada `callbackQuery.message` — dan objek itu sudah ada di tangan `engine.ts:922`. Ongkos sebenarnya satu fungsi murni belasan baris, nol perubahan DB.

Keputusannya **tetap** sempit, karena user belum meninjaunya ulang atas angka yang benar. Dicatat di sini supaya peninjauan itu punya tempat mendarat, dan supaya tidak ada yang mewarisi klaim "butuh skema DB" dari spec ini. Yang berubah bila ditinjau ulang bukan hanya tombol fallback: `buildTappedMessageEdit` akan menampilkan `→ ✏️ Explain manually` di layar user, bukan data mentah, untuk **semua** tombol.

**K-9. Aturan `buttons-when-pickable` disuntik ULANG setiap giliran lewat hook `UserPromptSubmit`.**

Keputusan user 2026-08-11. Ia **membatalkan** rancangan sebelumnya — satu klausa umpan balik `asked without buttons` di `formatSendResult` — yang sempat disetujui sebelum T-9 dan T-10 ditemukan. Dicatat sebagai pembatalan, bukan disunting seolah tidak pernah ada, karena alasan gugurnya adalah temuan dan itu bagian dari rekamannya.

Bentuknya: berkas baru `hooks/turn-reminder.ts`, terdaftar sebagai `UserPromptSubmit` di `hooks/hooks.json` — slot yang sekarang kosong (T-9).

*Alasan, dan ini bukan tebakan:* T-9. Bentuk ini sudah dipakai sistem lama untuk aturan yang sama persis, dengan alasan tertulis yang mendiagnosis T-8 kata per kata, dan MCP `instructions`-nya sengaja tidak menyebut tombol. Satu-satunya bentuk dalam spec ini yang punya bukti lapangan.

*Kenapa ia MENGGANTIKAN umpan balik hasil tool, bukan menambahinya:* hook bicara **sebelum** balasan disusun, hasil tool bicara **sesudah** terkirim. Yang pertama mencegah, dan pencegahan tidak butuh detektor. Itu menghapus seluruh batas "2 dari 3" yang T-8 ukur: tanpa pola `?` yang harus dicocokkan, tidak ada kelas yang lolos — kejadian ke-3 tercakup sama baiknya dengan dua lainnya. Menambahkan keduanya berarti membayar dua mekanisme untuk satu aturan, dan yang kedua hanya menangkap sisa yang tidak lagi ada.

*Kenapa hook TIDAK melanggar K-7:* doktrin `reminders.ts` menjaga **satu kanal tertentu** — `[from: system]` — dari menjadi latar belakang. Hook `UserPromptSubmit` menulis ke `additionalContext`, kanal berbeda yang tidak ikut mendorong isi ke `[from: system]`. Ambangnya karena itu tidak mengotori kanal yang doktrin itu lindungi. *Konsekuensi yang diterima sadar:* hook ini menyala di hampir setiap giliran Telegram, persis seperti pendahulunya, dan itu memang bentuknya.

*Deteksinya memakai sinyal yang sudah ada, dan hanya SATU dari dua yang tersedia.* `reply-guard` mengenali giliran kanal lewat `origin.server` **atau** regex tag `` `<channel[^>]*source="[^"]*cc-plugin` `` (`reply-guard.ts:168-171`). Hook `UserPromptSubmit` hanya menerima `{prompt}`, tanpa transcript, jadi sinyal `origin` tidak ada di sana — yang tersisa hanya regex tag. Dinyatakan di sini supaya tidak dicari-cari saat implementasi.

*Konsekuensi yang diterima sadar:* prompt yang cuma **menyebut** tag itu — misalnya saat user menanyakan bug pada hook ini — akan ikut menyalakannya. `reply-guard` harus memasang urutan pemeriksaan khusus untuk kasus itu karena ia **memblokir**; hook ini cuma menambah satu baris pengingat, jadi harganya satu baris, bukan giliran yang mati.

*Hook DIAM pada giliran antar-bot.* Prompt yang memuat `[from: agent]` tidak boleh dijawab dengan `reply` sama sekali (aturan `inter-bot-channel`), jadi mengingatkan soal tombol di sana adalah menyuruh melakukan hal yang aturan lain melarang. `reply-guard` sudah membayar pelajaran ini dengan bug nyata: *"pengecualian yang dipasang di satu penanda saja adalah pengecualian yang menjaga pintu sambil membuka jendela"* (`reply-guard.ts:51`).

*Teksnya menyebut TOOL dan PARAMETER-nya, bukan cuma tindakannya.* Pelajaran `name-session` di `reminders.ts:107-110`: pengingat yang menyuruh sebuah tindakan harus ikut menyebut alatnya, karena "AI pasti tahu caranya" adalah asumsi yang sudah terbukti salah sekali di repo ini — bot uji sampai membaca source code sebelum menemukan `send_slash`. Jadi barisnya menyebut parameter `buttons` pada `reply`, dan menyebut nama aturannya.

*Rule-id dieja sebagai literal di dalam hook,* karena hook hanya boleh mengimpor `node:` (T-3 spec 2026-08-10). Jaraknya ditutup test, idiom yang sama dengan `AGENT_TURN_MARKER` di `reply-guard.ts:34`.

*Yang TIDAK dilakukan:* memblokir, menolak, memaksa tombol muncul, atau menyentuh `formatSendResult`. Aturan ini tetap penilaian AI (bagian 5).

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

Hook per giliran (K-9), di berkas test baru `test/turn-reminder.test.ts` — mengikuti tempat `test/reply-guard.test.ts`, karena hook diuji sebagai hook, bukan sebagai modul engine:

12. Prompt **tanpa** tag channel milik plugin ini → hook diam (tidak menulis apa pun ke stdout).
13. Prompt dengan tag channel **tetapi** memuat `[from: agent]` → hook diam.
14. Prompt dengan tag `<channel … source="…cc-plugin…">` → hook menyala, dan barisnya memuat nama aturan `buttons-when-pickable` **dan** kata `buttons`.
15. Prompt yang cuma **menyebut** tag itu di dalam kalimat biasa → hook menyala. Ini bukan bug yang ditest sebagai fitur: ia mengunci konsekuensi yang K-9 terima sadar, supaya orang berikutnya tidak "memperbaikinya" tanpa membaca kenapa.

Nomor 12 dan 13 lebih penting daripada 14: pengingat yang muncul di giliran yang salah adalah bentuk kegagalan yang membunuh seluruh kanal ini — dan nomor 13 khususnya, karena ia menyuruh melakukan hal yang aturan `inter-bot-channel` melarang.

16. Rule-id yang dieja hook ada di `RULE_IDS`. Ini memperluas test yang sudah ada (K-4 spec 2026-08-10) ke penghuni baru; tanpa itu, mengganti nama aturan membuat hook menyebut nama yang tidak lagi ada, dan tidak ada yang gagal.

17. **`formatSendResult` tidak berubah sama sekali.** Empat test yang sudah ada (`server.test.ts:418-450`) harus tetap hijau **kata per kata**, termasuk `sent (642 chars)` yang polos. Rancangan yang menambahkan klausa di sana sudah dibatalkan (K-9), dan test ini yang memastikan pembatalannya benar-benar terjadi — bukan tertinggal setengah.

---

## 5. Batas yang diterima sadar

- **`findUnsafeButtonData` tidak memeriksa tombol injeksi saat runtime.** Injeksi terjadi sesudah `prepareReply`, jadi yang menjaganya adalah test nomor 7, bukan pemeriksaan tiap kirim. Wajar: datanya konstanta milik kode sendiri, bukan masukan dari luar.
- **Injeksi menambah satu baris, dan batas jumlah baris Telegram tidak diverifikasi.** Skill lama mengklaim "max 8 baris × 8 tombol"; klaim itu **tidak** diuji ulang, dan pagar jumlah tombol per baris memang sengaja tidak dipasang (`docs/2026-08-10-review-temuan-perbaikan.md:96`). Yang diketahui pasti hanya batas 100 tombol per pesan. Risikonya kecil — butuh keyboard 8+ baris dalam satu balasan chat — dan bila terjadi ia **tidak diam**: Telegram menjawab 400 dan `sendOutgoing` sudah membungkusnya menjadi `reply failed after N of M parts sent`. Memasang pagar atas batas yang belum diukur hanya memindahkan tebakan ke dalam kode.
- **`buttons: []` tetap menghasilkan `reply_markup` kosong seperti hari ini.** Array kosong bersifat truthy di JS, jadi ternary di `:1065` tetap masuk; K-5 nomor 1 mengembalikannya apa adanya. Perilakunya tidak berubah, dan sengaja tidak diperbaiki di spec ini — itu keanehan yang sudah ada sebelumnya dan bukan bagian dari keluhan yang memicu spec ini.
- **`buttons-when-pickable` tidak akan pernah punya penegak yang MEMBLOKIR.** T-7 menutup jalur itu dengan keputusan user yang berdasar bukti. Yang menjaganya adalah teks aturan (K-6) plus pengingat per giliran (K-9) — dua-duanya bisa diabaikan AI, dan itu memang bentuknya. Yang bisa dijamin mesin sudah dijamin: baris **terakhir**. Baris **pertama** tetap penilaian yang memang milik AI.
- **Hook K-9 menyala di hampir setiap giliran, dan itu tidak diukur sebagai gangguan.** Pendahulunya di sistem lama hidup berbulan-bulan dalam bentuk itu tanpa keluhan yang tercatat, tapi "tidak ada keluhan" bukan pengukuran. Yang belum diketahui: apakah pengingat yang selalu ada akhirnya berhenti terbaca. Bila itu terjadi, gejalanya akan terlihat sebagai kejadian keempat di T-8 — dan penawarnya bukan menambah mekanisme, melainkan memendekkan barisnya.
- **Hook ikut menyala pada prompt yang cuma menyebut tag channel.** Harganya satu baris pengingat yang tidak relevan; alternatifnya adalah pemeriksaan `origin` yang tidak tersedia di hook `UserPromptSubmit` (K-9). Dikunci oleh test nomor 15 supaya tidak diperbaiki tanpa membaca alasannya.

---

## 6. Yang TIDAK dikerjakan

- **Menyimpan keyboard yang dikirim** supaya tap bisa dilaporkan berlabel (K-8). Spec terpisah.
- **Menyalakan ulang `inline-buttons@mirza-marketplace`** (T-3). Ia akan mengajarkan skema yang ditolak.
- **Menerjemahkan `data` menjadi kalimat di handler tap** (K-4). Dihapus dari desain, bukan ditunda.
- **Pagar jumlah tombol per baris atau per keyboard.** Batasnya belum diukur (bagian 5).
- **Memindahkan aturan apa pun antara `INSTRUCTION_BLOCKS` dan `reminders.ts`** selain menambah dua penghuni baru di yang pertama (K-7).
- **Menyentuh keyboard milik lapisan slash** (`engine.ts:644`, `:771`). Tombol "explain manually" di daftar sesi tidak berarti apa-apa.
- **Memblokir atau menolak `reply` yang tidak membawa tombol.** Pengingatnya memberi tahu, bukan menggerbangi. Menjadikannya gerbang berarti menghidupkan ulang aturan yang user bunuh 2026-08-01 (T-7), kali ini dengan pakaian berbeda.
- **Menambah klausa apa pun ke `formatSendResult`** (K-9). Rancangan itu dibatalkan, dan test nomor 17 menjaga pembatalannya.
- **Memulihkan label tombol yang ditap** (K-8, T-10). Ongkosnya ternyata murah, tapi keputusan cakupan sempit belum ditinjau ulang — dan meninjaunya di tengah implementasi adalah cara spec kehilangan batasnya.
- **Menaruh aturan tombol sebagai skill.** Bentuk itu sudah dicoba di sistem lama dengan kondisi terbaiknya — `description`-nya memuat seluruh aturan dan diawali *"MANDATORY before sending every Telegram reply"*, jadi ia hadir di context tanpa perlu di-invoke — dan tetap bocor (T-2). Skill juga tidak bisa punya rule-id, sehingga pelanggarannya tak bisa disebut namanya maupun dihitung.
