# Tombol Fallback `✏️ Explain manually` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setiap keyboard yang AI kirim lewat `reply` selalu berakhir dengan satu baris `✏️ Explain manually` yang ditempelkan kode, dan kebiasaan **menawarkan** tombol dijaga dua aturan bernama plus satu hook per giliran.

**Architecture:** Tiga lapisan yang tidak saling menggantikan. (1) Mesin menempelkan baris terakhir lewat satu fungsi murni di `messages.ts` yang dipanggil di satu titik di `engine.ts`. (2) Dua aturan bernama baru di `INSTRUCTION_BLOCKS` mengajarkan kapan menawarkan dan apa yang dilakukan saat jalan keluar itu ditap. (3) Satu hook `UserPromptSubmit` menyuntik ulang aturan pertama setiap giliran Telegram, karena instruksi yang dibaca sekali di awal sesi memudar di giliran yang padat. Tidak ada satu pun yang memblokir.

**Tech Stack:** TypeScript, Bun (runtime + test runner), grammy (Telegram), Claude Code plugin hooks.

**Spec:** `docs/2026-08-11-tombol-fallback-manual-spec.md`. Setiap keputusan di bawah merujuk nomor K-n di spec itu.

## Global Constraints

- **Label tombol, verbatim:** `✏️ Explain manually` (K-3).
- **`callback_data` tombol, verbatim:** `let me explain manually instead` (K-3). 31 byte.
- **Nama aturan, verbatim:** `buttons-when-pickable` dan `manual-fallback-tap` (K-6). Kebab-case, dijaga test yang sudah ada.
- **Teks aturan dan teks hook: bahasa Inggris.** `INSTRUCTION_BLOCKS` seluruhnya Inggris karena ia instruksi mesin→AI, bukan pesan ke user.
- **Komentar dan pesan commit: bahasa Indonesia,** mengikuti seluruh berkas yang disentuh.
- **Hook hanya boleh mengimpor `node:`.** Bukan gaya: versi pertama `hooks/session-start.ts` yang mengimpor modul engine tidak pernah menyala sama sekali padahal terlihat terpasang (T-3 spec 2026-08-10). Literal yang terduplikasi ditutup TEST, bukan import.
- **Injeksi hanya bila `buttons` tidak kosong** (K-1). Injeksi tanpa syarat membuat setiap `reply` yang mengirim berkas gagal lewat `assertNoButtonsWithFiles`.
- **`formatSendResult` tidak boleh disentuh sama sekali** (K-9). Rancangan yang menambah klausa di sana sudah dibatalkan.
- **Perintah verifikasi**, dijalankan dari `cc-plugin/`: `bun test` dan `bunx tsc --noEmit`.
- **Baseline sebelum plan ini:** 725 pass, 0 fail, `tsc` bersih, versi `0.43.0`.

---

### Task 1: Konstanta + fungsi murni `withManualFallback`

**Files:**
- Modify: `cc-plugin/src/engine/messages.ts` (baris 12 — import type; sisipkan blok baru sesudah `buildInlineKeyboard` di baris 341-348)
- Modify: `cc-plugin/test/engine/messages.test.ts` (baris 5-14 — daftar import; baris 391 — satu string mentah; sisipkan `describe` baru sesudah blok `findUnsafeButtonData`)

**Interfaces:**
- Consumes: `Button`, `ButtonRow` dari `src/engine/types.ts` (`Button = { text: string; data: string }`, `ButtonRow = Button[]`); `findUnsafeButtonData(buttons?: ButtonRow[]): string | null` dari berkas yang sama.
- Produces: `MANUAL_FALLBACK_BUTTON: Button` dan `withManualFallback(rows: ButtonRow[]): ButtonRow[]`, keduanya diekspor dari `src/engine/messages.ts`. Task 2 memakai `withManualFallback`; Task 4 tidak memakai keduanya.

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di `cc-plugin/test/engine/messages.test.ts`. Helper `row` sudah ada di dalam `describe` lain (baris 350) — blok ini membawa helper-nya sendiri supaya tidak bergantung pada urutan berkas.

```ts
describe("withManualFallback", () => {
  const row = (...texts: string[]) => texts.map((text) => ({ text, data: `d_${text}` }));

  test("keyboard kosong tidak mendapat tombol apa pun", () => {
    // K-1: tombol jalan keluar sendirian adalah keyboard yang menawarkan jalan
    // keluar dari nol pilihan. Dan `assertNoButtonsWithFiles` melempar kalau
    // buttons terisi bersama files -- injeksi tanpa syarat mematikan jalur berkas.
    expect(withManualFallback([])).toEqual([]);
  });

  test("satu baris tombol mendapat satu baris fallback di bawahnya", () => {
    const out = withManualFallback([row("1", "2")]);
    expect(out.length).toBe(2);
    expect(out[1]).toEqual([MANUAL_FALLBACK_BUTTON]);
  });

  test("baris tombol yang sudah ada tidak diubah", () => {
    const asli = row("1", "2");
    const out = withManualFallback([asli]);
    expect(out[0]).toEqual(row("1", "2"));
  });

  test("fallback yang sudah ada di baris terakhir tidak jadi kembar", () => {
    const out = withManualFallback([row("1", "2"), [MANUAL_FALLBACK_BUTTON]]);
    expect(out.length).toBe(2);
  });

  test("fallback yang sudah ada di baris TENGAH juga tidak jadi kembar", () => {
    // K-5: dedupe berdasarkan keberadaan, bukan posisi. Memeriksa posisi
    // menuntut keputusan kedua -- pindahkan atau biarkan -- dan memindahkan
    // tombol yang AI tulis sendiri adalah mesin menyunting maksud AI.
    const out = withManualFallback([[MANUAL_FALLBACK_BUTTON], row("1")]);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual([MANUAL_FALLBACK_BUTTON]);
  });

  test("dedupe memakai data, bukan label", () => {
    // Label bisa berubah kapan saja tanpa mengubah arti tombolnya; data adalah
    // identitasnya. Doktrin yang sama dipakai skill lama: "labels can change;
    // ids are stable".
    const berlabelLain = [{ text: "apa saja", data: MANUAL_FALLBACK_BUTTON.data }];
    expect(withManualFallback([berlabelLain]).length).toBe(1);
  });

  test("idempoten", () => {
    const sekali = withManualFallback([row("1")]);
    expect(withManualFallback(sekali)).toEqual(sekali);
  });

  test("masukan tidak dimutasi", () => {
    const masukan = [row("1")];
    withManualFallback(masukan);
    expect(masukan.length).toBe(1);
  });

  // Pengganti pemeriksaan runtime, dan bentuknya yang penting: ia menjalankan
  // PAGAR YANG SEBENARNYA, bukan menyalin ambangnya. `expect(byteLength).
  // toBeLessThan(64)` akan melahirkan salinan kedua dari angka 64, yaitu persis
  // kelas kegagalan yang doktrin repo ini larang -- dua literal yang harus sama
  // akan menyimpang diam-diam. Dengan bentuk ini, memperketat pagarnya membuat
  // test ini ikut tahu.
  test("tombol injeksi lolos pagar callback_data yang sebenarnya", () => {
    expect(findUnsafeButtonData([[MANUAL_FALLBACK_BUTTON]])).toBeNull();
  });
});
```

Perluas daftar import di baris 5-14 berkas itu dengan dua nama baru:

```ts
import {
  deliverIncoming,
  normalizeMessage,
  buildAlbumMessage,
  buildTappedMessageEdit,
  findMissingButtonNarration,
  findUnsafeButtonData,
  handleHistoryRequest,
  handleSearchRequest,
  MANUAL_FALLBACK_BUTTON,
  withManualFallback,
} from "../../src/engine/messages";
```

- [ ] **Step 2: Jalankan test, pastikan MERAH**

Run: `cd cc-plugin && bun test test/engine/messages.test.ts`
Expected: FAIL. Bun melaporkan error resolusi import untuk `MANUAL_FALLBACK_BUTTON` dan `withManualFallback` — keduanya belum ada. Kalau yang muncul justru PASS, berhenti: berarti test-nya tidak benar-benar dijalankan.

- [ ] **Step 3: Tulis implementasi minimal**

Di `cc-plugin/src/engine/messages.ts`, ubah baris 12 supaya `Button` ikut terbawa:

```ts
import type { Button, ButtonRow, MessagesResult } from "./types";
```

Lalu sisipkan blok berikut **sesudah** `buildInlineKeyboard` (yang berakhir di baris 348), supaya ia bertetangga dengan pagar tombol lain di berkas ini:

```ts
/**
 * Tombol jalan keluar yang mesin tempelkan ke SETIAP keyboard yang AI kirim.
 *
 * Kenapa mesin, bukan aturan: sistem lama sudah meminta AI menempelkannya
 * sendiri lewat "self-check ritual", dan berkas aturannya sendiri mencatat
 * hasilnya -- "the single most forgotten rule in this skill". Aturan ini sudah
 * pernah gagal dalam bentuk instruksi, di sistem yang instruksinya masih hidup.
 *
 * Kenapa `data`-nya sepanjang ini, bukan `manual`: data dibaca DUA pembaca.
 * `buildTappedMessageEdit` di atas menempelkannya ke pesan yang ditap, jadi
 * user melihatnya di layar; dan tap mendaratkannya di context AI sebagai pesan
 * user. Data bisu gagal di dua-duanya -- di layar terbaca seperti kebocoran
 * internal, di context ia satu token tanpa arti begitu sesi berganti.
 *
 * Kenapa berbentuk "let me ...", bukan "explain manually": ia mendarat SEBAGAI
 * PESAN USER. "explain manually" dari mulut user terbaca sebagai perintah
 * kepada AI untuk menjelaskan -- arahnya terbalik dari maksudnya.
 *
 * 31 byte, jauh di bawah batas 64 byte `callback_data`. Yang menjaga angka itu
 * adalah test yang menjalankan `findUnsafeButtonData` atas konstanta ini, bukan
 * salinan kedua dari angka 64 di dalam test.
 */
export const MANUAL_FALLBACK_BUTTON: Button = {
  text: "✏️ Explain manually",
  data: "let me explain manually instead",
};

/**
 * Menempelkan `MANUAL_FALLBACK_BUTTON` sebagai baris TERAKHIR, dan tidak
 * melakukan apa-apa pada keyboard kosong.
 *
 * Keyboard kosong dilewati bukan demi kerapian: `assertNoButtonsWithFiles`
 * melempar bila `buttons` dan `files` sama-sama terisi, jadi injeksi tanpa
 * syarat akan membuat SETIAP balasan yang mengirim berkas gagal.
 *
 * Dedupe-nya berdasarkan `data` dan mengabaikan posisi. Label bisa berubah
 * tanpa mengubah arti tombolnya; data adalah identitasnya. Dan memeriksa
 * posisi menuntut keputusan kedua -- pindahkan atau biarkan -- sementara
 * memindahkan tombol yang AI tulis sendiri adalah mesin menyunting maksud AI.
 * Konsekuensinya diterima sadar: fallback yang AI tulis di tengah tetap di
 * tengah. Aturan `buttons-when-pickable` melarang AI menulisnya, jadi dedupe
 * ini jaring, bukan jalan utama.
 *
 * Idempoten, dan itu yang membuatnya aman dipanggil dari titik kedua kalau
 * suatu hari ada.
 */
export function withManualFallback(rows: ButtonRow[]): ButtonRow[] {
  if (rows.length === 0) return rows;
  for (const r of rows) {
    for (const b of r) {
      if (b.data === MANUAL_FALLBACK_BUTTON.data) return rows;
    }
  }
  return [...rows, [MANUAL_FALLBACK_BUTTON]];
}
```

- [ ] **Step 4: Jalankan test, pastikan HIJAU**

Run: `cd cc-plugin && bun test test/engine/messages.test.ts`
Expected: PASS, 9 test baru hijau, dan seluruh test lama di berkas itu tetap hijau.

- [ ] **Step 5: Hapus satu literal kembar di test lama**

`cc-plugin/test/engine/messages.test.ts` baris 391 menulis label itu sebagai string mentah. Setelah konstanta lahir, dua literal yang harus sama duduk di dua berkas dan bebas menyimpang — dan yang menyimpang di sini membuat test itu menjaga tombol yang sudah tidak ada.

Ganti:

```ts
        row("1", "2", "✏️ Explain manually")
```

menjadi:

```ts
        row("1", "2", MANUAL_FALLBACK_BUTTON.text)
```

- [ ] **Step 6: Jalankan seluruh test + typecheck**

Run: `cd cc-plugin && bun test && bunx tsc --noEmit`
Expected: 734 pass, 0 fail (725 baseline + 9 baru). `tsc` tanpa keluaran.

- [ ] **Step 7: Commit**

```bash
git add cc-plugin/src/engine/messages.ts cc-plugin/test/engine/messages.test.ts
git commit -m "feat(cc-plugin): fungsi murni yang menempelkan tombol jalan keluar

withManualFallback + MANUAL_FALLBACK_BUTTON, belum dipanggil siapa pun.
Dedupe by data bukan posisi, idempoten, dan keyboard kosong dilewati --
syarat terakhir itu mekanis, bukan selera: assertNoButtonsWithFiles akan
menolak setiap balasan berkas kalau injeksinya tanpa syarat.

Batas 64 byte dijaga dengan menjalankan findUnsafeButtonData atas
konstantanya, bukan dengan menyalin angka 64 ke dalam test.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pasang injeksi di jalur `reply`

Task 1 menghasilkan fungsi yang benar tapi tidak pernah dipanggil — dan fungsi seperti itu lolos seluruh test unit. Task ini yang membuktikan titik panggilnya terpasang.

**Files:**
- Modify: `cc-plugin/src/engine/engine.ts` (baris 75 — daftar import dari `./messages`; baris 1065 — satu baris di dalam `sendOutgoing`)
- Modify: `cc-plugin/test/engine/engine.test.ts` (baris 164-196 — harness `withFakeTelegram`; tambah dua test sesudah blok W-27)

**Interfaces:**
- Consumes: `withManualFallback(rows: ButtonRow[]): ButtonRow[]` dan `MANUAL_FALLBACK_BUTTON` dari Task 1; `buildInlineKeyboard(rows: ButtonRow[]): InlineKeyboard` yang sudah ada.
- Produces: tidak ada API baru. Yang berubah perilaku: `engine.reply(text, buttons, ...)` kini mengirim keyboard dengan satu baris tambahan di bawah.

**Kenapa `engine.test.ts`, bukan `reply-outgoing.test.ts`:** berkas yang namanya paling menjanjikan itu ternyata hanya menguji helper murni (`storeOutgoing`, `buildSendOptions`) — tidak ada bot palsu di sana sama sekali. Harness yang benar-benar menjalankan `startEngine` dan mencegat HTTP Telegram ada di `engine.test.ts:164` (`withFakeTelegram`, sebuah `Bun.serve` sungguhan). Itu satu-satunya tempat di repo ini yang bisa membuktikan titik panggil terpasang.

- [ ] **Step 1: Perluas harness supaya ia menangkap BODY, bukan cuma chat id**

`withFakeTelegram` di `engine.test.ts:164` hanya mengumpulkan `chat_id`. Tambah satu penampung ketiga. Parameter baru di posisi terakhir, jadi dua pemanggil yang sudah ada (`async () =>` dan `async (_baseUrl, sentTo) =>`) tidak perlu disentuh.

Ubah tanda tangannya:

```ts
function withFakeTelegram<T>(
  fn: (baseUrl: string, sentTo: string[], bodies: Record<string, unknown>[]) => Promise<T>
): Promise<T> {
  const sentTo: string[] = [];
  // Body request yang UTUH. `sentTo` menjawab "ke chat mana", dan itu cukup
  // untuk W-27; keyboard butuh pertanyaan lain -- "apa yang dikirim".
  const bodies: Record<string, unknown>[] = [];
```

Di dalam cabang `sendMessage`, tambahkan satu baris sesudah `sentTo.push(...)`:

```ts
        bodies.push(body as Record<string, unknown>);
```

dan di baris terakhirnya teruskan penampung baru itu:

```ts
  return fn(process.env.TELEGRAM_API_ROOT, sentTo, bodies).finally(() => {
```

- [ ] **Step 2: Tulis test yang gagal**

Tambahkan sesudah tiga test W-27. Pola pra-isi database disalin dari W-27 test 1 — `reply` menolak dengan `no_known_chat` kalau bot ini belum pernah punya chat.

```ts
// Test unit di messages.test.ts TIDAK membuktikan ini: fungsi murni yang benar
// tapi tidak pernah dipanggil lolos semuanya. Yang dijaga di sini adalah TITIK
// PANGGILNYA, dan satu-satunya bukti yang sah adalah body yang benar-benar
// berangkat ke Telegram.
test("keyboard yang benar-benar dikirim berakhir dengan tombol jalan keluar", async () => {
  await withFakeTelegram(async (_baseUrl, _sentTo, bodies) => {
    const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["1"] });

    const db = openConversationsDb(conversationsDbPathIn(home));
    insertMessage(db, { ts: "t", bot: "bot-uji", chatId: "555", source: "user", text: "halo" });
    db.close();

    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    await res.engine.reply("Pilih:\n1. Lanjut\n2. Batal", [
      [
        { text: "1", data: "opt-1" },
        { text: "2", data: "opt-2" },
      ],
    ]);

    const markup = bodies.at(-1)!.reply_markup as { inline_keyboard: unknown[][] };
    expect(markup.inline_keyboard.length).toBe(2);
    expect(markup.inline_keyboard[1]).toEqual([
      { text: MANUAL_FALLBACK_BUTTON.text, callback_data: MANUAL_FALLBACK_BUTTON.data },
    ]);

    res.engine.close();
  });
});

// Cabang `undefined` di titik injeksi. Kalau ia ikut disentuh, balasan biasa
// mulai membawa keyboard berisi satu tombol jalan keluar dari nol pilihan --
// dan balasan biasa adalah mayoritas mutlak.
test("balasan tanpa tombol tetap tanpa keyboard sama sekali", async () => {
  await withFakeTelegram(async (_baseUrl, _sentTo, bodies) => {
    const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["1"] });

    const db = openConversationsDb(conversationsDbPathIn(home));
    insertMessage(db, { ts: "t", bot: "bot-uji", chatId: "555", source: "user", text: "halo" });
    db.close();

    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    await res.engine.reply("cuma teks biasa");
    expect(bodies.at(-1)!.reply_markup).toBeUndefined();

    res.engine.close();
  });
});
```

Perluas daftar import di kepala `engine.test.ts` dengan `MANUAL_FALLBACK_BUTTON` dari `../../src/engine/messages`. `botFolder`, `openConversationsDb`, `conversationsDbPathIn`, `insertMessage`, dan `startEngine` sudah diimpor di sana untuk test W-27.

Dua catatan bentuk, keduanya sudah diperiksa terhadap kode nyata:

1. grammy menyimpan tombol sebagai `{ text, callback_data }`, bukan `{ text, data }` — `buildInlineKeyboard` menerjemahkannya lewat `kb.text(btn.text, btn.data)`. Assertion di atas sudah memakai bentuk grammy.
2. Kalau ternyata `reply_markup` mendarat sebagai **string** (grammy menyerialkannya untuk request `multipart`, bukan `application/json`), assertion-nya gagal dengan pesan tipe, bukan diam. Perbaikannya satu baris: `JSON.parse(bodies.at(-1)!.reply_markup as string)`. Diperiksa saat implementasi, bukan ditebak sekarang.

- [ ] **Step 3: Jalankan test, pastikan MERAH**

Run: `cd cc-plugin && bun test test/engine/engine.test.ts`
Expected: test pertama FAIL — `inline_keyboard.length` bernilai `1`, bukan `2`. Test kedua sudah PASS (itu perilaku hari ini); ia penjaga regresi, bukan fitur baru, dan memang seharusnya hijau sejak awal.

**Jalur berkas tidak diberi test baru di sini.** `test/engine/attach-send.test.ts` sudah menjaganya, dan yang melindunginya dari injeksi adalah `assertNoButtonsWithFiles` yang jalan **sebelum** titik injeksi. Menambah test berkas ketiga di sini berarti memalsukan `sendPhoto`/`sendDocument` di harness yang belum pernah memerlukannya — ongkos yang tidak dibayar oleh jaminan tambahan apa pun.

- [ ] **Step 4: Tulis implementasi minimal**

Di `cc-plugin/src/engine/engine.ts`, tambahkan `withManualFallback` ke daftar import dari `./messages` (baris 75 berada di dalam daftar itu):

```ts
  buildInlineKeyboard,
  withManualFallback,
```

Lalu ubah baris 1065 dari:

```ts
        const replyMarkup = buttons ? buildInlineKeyboard(buttons) : undefined;
```

menjadi:

```ts
        // Tombol jalan keluar ditempelkan DI SINI, sesudah `prepareReply`.
        //
        // Kenapa titik ini: `buildInlineKeyboard` punya satu pemanggil, yaitu
        // baris ini, sementara menu milik lapisan slash menyusun
        // `inline_keyboard` literalnya sendiri. Jadi injeksi di sini otomatis
        // hanya kena tombol AI, dan menu mesin tidak ikut ketularan tombol
        // yang tak berarti bagi mereka.
        //
        // Kenapa BUKAN di dalam `buildInlineKeyboard`: hari ini hasilnya
        // identik, tapi pemanggil kedua besok akan kena tanpa penulisnya
        // sadar -- dan nama fungsi itu berarti "ubah rows jadi keyboard".
        // Menambah tombol di dalamnya membuat namanya berbohong.
        //
        // Cabang `undefined` sengaja tidak disentuh: itu yang membuat jalur
        // berkas tetap aman tanpa satu baris tambahan.
        const replyMarkup = buttons
          ? buildInlineKeyboard(withManualFallback(buttons))
          : undefined;
```

- [ ] **Step 5: Jalankan test, pastikan HIJAU**

Run: `cd cc-plugin && bun test test/engine/engine.test.ts && bun test && bunx tsc --noEmit`
Expected: seluruhnya PASS, 736 pass, `tsc` bersih.

- [ ] **Step 6: Commit**

```bash
git add cc-plugin/src/engine/engine.ts cc-plugin/test/engine/engine.test.ts
git commit -m "feat(cc-plugin): setiap keyboard AI berakhir dengan jalan keluar

Satu baris di sendOutgoing. Titiknya dipilih karena buildInlineKeyboard cuma
punya satu pemanggil, sementara menu /branch dan /switch menyusun
inline_keyboard literalnya sendiri -- jadi scoping-nya gratis.

Test integrasi yang menyertainya menjaga dua arah: keyboard yang benar-benar
dikirim punya barisnya, dan balasan berkas tetap tanpa reply_markup.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Dua aturan bernama di `INSTRUCTION_BLOCKS`

**Files:**
- Modify: `cc-plugin/src/server.ts` (sisipkan dua entri di `INSTRUCTION_BLOCKS`, sesudah blok `reply-length` yang berakhir di baris 204)
- Modify: `cc-plugin/test/server.test.ts` (tambah test di dalam `describe("aturan bernama di dalam instructions")`, baris 897)

**Interfaces:**
- Consumes: `InstructionBlock { id?: string; text: string }` yang sudah ada.
- Produces: dua id baru di `RULE_IDS` — `buttons-when-pickable` dan `manual-fallback-tap`. Task 4 mengeja id pertama sebagai literal di dalam hook.

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di `cc-plugin/test/server.test.ts` di dalam `describe` yang sudah ada di baris 897:

```ts
  // Disebut satu per satu, bukan cuma diandalkan ke test "semua id muncul":
  // aturan yang HILANG tidak akan membuat test itu merah, karena ia hanya
  // memeriksa id yang ada. Yang dijaga di sini keberadaannya.
  test("dua aturan tombol ada, dan keduanya sampai ke pembacanya", () => {
    expect(RULE_IDS).toContain("buttons-when-pickable");
    expect(RULE_IDS).toContain("manual-fallback-tap");
  });

  // Kalimat aturannya harus menyebut PARAMETERNYA, bukan cuma "tawarkan
  // tombol". Pelajaran `name-session`: pengingat yang menyuruh sebuah tindakan
  // tanpa menyebut alatnya membuat bot uji membaca source code repo sebelum
  // menemukan tool-nya.
  test("aturan tombol menyebut parameter yang harus dipakai", () => {
    expect(SERVER_INSTRUCTIONS).toContain("Rule buttons-when-pickable:");
    expect(SERVER_INSTRUCTIONS).toContain("`buttons`");
  });

  // Data tombolnya adalah SATU-SATUNYA sinyal yang AI terima saat jalan keluar
  // itu ditap (K-4: tidak ada penerjemah). Kalau aturannya tidak mengeja data
  // itu, AI menerima kalimat yang tidak dikenalnya dan menebak.
  test("aturan tap mengeja data tombolnya, karena tidak ada penerjemah", () => {
    expect(SERVER_INSTRUCTIONS).toContain("let me explain manually instead");
  });
```

- [ ] **Step 2: Jalankan test, pastikan MERAH**

Run: `cd cc-plugin && bun test test/server.test.ts`
Expected: tiga test baru FAIL — `RULE_IDS` belum memuat id-id itu.

- [ ] **Step 3: Tulis implementasi minimal**

Di `cc-plugin/src/server.ts`, sisipkan dua entri **sesudah** blok `reply-length` (berakhir baris 204) dan **sebelum** blok `inter-bot-channel`. Urutan itu bukan selera: ketiganya soal bagaimana satu balasan ke user disusun, sementara yang sesudahnya soal lalu lintas antar-bot.

```ts
  // DUA ENTRI, BUKAN SATU. Alasannya doktrin yang sama yang memecah
  // `reply-required` dari `no-prose` (spec 2026-08-10 K-3): satu id untuk dua
  // kewajiban membuat catatan pelanggaran tidak bisa membedakan dua kegagalan
  // yang obatnya berlawanan. Di sini keduanya adalah LUPA MENAWARKAN dan SALAH
  // MERESPONS TAP.
  //
  // Kalimat terakhir aturan pertama -- larangan menulis tombol jalan keluar
  // sendiri -- adalah pasangan dedupe di `withManualFallback`: mesin yang sudah
  // menjamin kehadirannya membuat tulisan tangan AI jadi risiko kembar, bukan
  // cadangan.
  {
    id: "buttons-when-pickable",
    text:
      "Before sending a `reply`, ask one question about it: can the answer you want be picked " +
      "from a short list? A confirmation where yes/no genuinely settles it, or a menu of 2-4 " +
      "named options -- both qualify, so attach `buttons`. Anything whose real answer is prose " +
      "does not: an opinion, an explanation, a preference you cannot enumerate. A question mark " +
      "is not the trigger, and flattening a real question into a false binary to earn a keyboard " +
      "is worse than sending it as text. Keep labels short: for menus, narrate the options as a " +
      "numbered list in the body and let the buttons be the bare numbers. Never write the " +
      "escape-hatch button yourself -- the engine appends it to every keyboard you send.",
  },
  // Kalimat terakhirnya memaku CAKUPANNYA ke satu balasan, dan itu keputusan
  // user 2026-08-11 atas kekhawatiran yang ia ajukan sendiri: "jangan kirim
  // tombol lagi" tidak menyebut sampai kapan, dan AI yang menebak "seterusnya"
  // akan mematikan fitur tombol pelan-pelan gara-gara tombol yang seharusnya
  // sekali pakai.
  {
    id: "manual-fallback-tap",
    text:
      "When `let me explain manually instead` arrives as the user's message, they tapped the " +
      "escape hatch: the options you offered did not fit. Answer with a single `reply` carrying " +
      "no buttons at all, inviting them to say it in their own words. That applies to THAT reply " +
      "only -- on the next turn, offer buttons again as usual under the rule above.",
  },
```

- [ ] **Step 4: Jalankan test, pastikan HIJAU**

Run: `cd cc-plugin && bun test test/server.test.ts && bun test && bunx tsc --noEmit`
Expected: PASS. 739 pass. Test `nama aturan berbentuk kebab-case` dan `nama aturan unik` yang sudah ada ikut menjaga dua id baru tanpa perubahan.

- [ ] **Step 5: Commit**

```bash
git add cc-plugin/src/server.ts cc-plugin/test/server.test.ts
git commit -m "feat(cc-plugin): dua aturan bernama untuk kebiasaan menawarkan tombol

buttons-when-pickable dan manual-fallback-tap. Dipecah dua, bukan satu,
karena satu id untuk dua kewajiban membuat catatan pelanggaran tidak bisa
membedakan lupa-menawarkan dari salah-merespons-tap.

Aturan pertama melarang AI menulis tombol jalan keluar sendiri -- mesin
sudah menjaminnya, jadi tulisan tangan cuma risiko kembar. Aturan kedua
memaku cakupan 'balas tanpa tombol' ke SATU balasan, supaya tombol sekali
pakai tidak mematikan fitur tombol seterusnya.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Hook `UserPromptSubmit` yang menyuntik ulang aturan tiap giliran

**Files:**
- Create: `cc-plugin/hooks/turn-reminder.ts`
- Create: `cc-plugin/test/turn-reminder.test.ts`
- Modify: `cc-plugin/hooks/hooks.json` (tambah slot `UserPromptSubmit`)

**Interfaces:**
- Consumes: `RULE_IDS` dari `src/server` — hanya di dalam test, tidak di dalam hook (hook cuma boleh mengimpor `node:`).
- Produces: `buildTurnReminder(prompt: string): string | null` dan `RULE_BUTTONS_WHEN_PICKABLE: string`, keduanya diekspor dari `hooks/turn-reminder.ts`.

- [ ] **Step 1: Tulis test yang gagal**

Buat `cc-plugin/test/turn-reminder.test.ts`. Bentuk prompt di bawah disalin dari `test/reply-guard.test.ts` (yang aslinya disalin dari transcript nyata), bukan dikarang — hook yang hanya mengerti bentuk karangan akan terpasang dan tidak melakukan apa pun.

```ts
import { describe, test, expect } from "bun:test";
import { buildTurnReminder, RULE_BUTTONS_WHEN_PICKABLE } from "../hooks/turn-reminder";
import { RULE_IDS } from "../src/server";

const promptKanal = (penanda: string) =>
  `<channel source="plugin:cc-plugin:cc-plugin" chat_id="111" user_id="111" ` +
  `kind="message" message_id="9">\n${penanda}\nhalo\n</channel>`;

describe("buildTurnReminder", () => {
  // Giliran yang diketik langsung di terminal, atau giliran plugin lain.
  // Pengingat yang menyala di sana mengajarkan bahwa penanda di sini kadang
  // tidak berarti apa-apa.
  test("diam pada prompt tanpa tag channel milik plugin ini", () => {
    expect(buildTurnReminder("tolong benerin bug di parser")).toBeNull();
  });

  test("diam pada tag channel milik plugin LAIN", () => {
    expect(
      buildTurnReminder('<channel source="plugin:telegram:telegram" chat_id="1">hai</channel>')
    ).toBeNull();
  });

  // Aturan `inter-bot-channel` melarang `reply` sama sekali di giliran ini.
  // Mengingatkan soal tombol di sana adalah menyuruh melakukan hal yang aturan
  // lain melarang. reply-guard sudah membayar pelajaran ini dengan bug nyata:
  // pengecualian yang dipasang di satu penanda saja menjaga pintu sambil
  // membuka jendela.
  test("diam pada giliran antar-bot meski tag channelnya ada", () => {
    expect(buildTurnReminder(promptKanal("[from: agent]"))).toBeNull();
  });

  test("menyala pada giliran Telegram, dan menyebut aturan serta parameternya", () => {
    const r = buildTurnReminder(promptKanal("[from: user]"));
    expect(r).not.toBeNull();
    expect(r!).toContain(RULE_BUTTONS_WHEN_PICKABLE);
    expect(r!).toContain("`buttons`");
    expect(r!).toContain("`reply`");
  });

  // BUKAN bug yang ditest sebagai fitur. Hook UserPromptSubmit hanya menerima
  // { prompt }, tanpa transcript, jadi sinyal `origin` yang dipakai reply-guard
  // tidak tersedia di sini -- yang tersisa cuma regex tag. Harganya satu baris
  // pengingat yang tidak relevan, bukan giliran yang mati, karena hook ini
  // tidak memblokir apa pun. Dikunci supaya tidak "diperbaiki" tanpa membaca
  // kenapa.
  test("ikut menyala saat prompt cuma MENYEBUT tag itu -- konsekuensi yang disengaja", () => {
    expect(
      buildTurnReminder('kenapa hook-nya nyala kalau ada <channel source="plugin:cc-plugin:cc-plugin">?')
    ).not.toBeNull();
  });
});

// Pengganti impor yang dilarang. Tanpa test ini, mengganti nama aturan di
// server.ts membuat hook menyebut nama yang tidak lagi ada, dan tidak ada yang
// gagal. Idiom yang sama dipakai AGENT_TURN_MARKER di reply-guard.
test("rule-id yang dieja hook ada di daftar sumbernya", () => {
  expect(RULE_IDS).toContain(RULE_BUTTONS_WHEN_PICKABLE);
});
```

- [ ] **Step 2: Jalankan test, pastikan MERAH**

Run: `cd cc-plugin && bun test test/turn-reminder.test.ts`
Expected: FAIL, error resolusi modul — `hooks/turn-reminder.ts` belum ada.

- [ ] **Step 3: Tulis implementasi minimal**

Buat `cc-plugin/hooks/turn-reminder.ts`:

```ts
#!/usr/bin/env bun
/**
 * UserPromptSubmit hook: menyuntik ulang aturan tombol SETIAP giliran Telegram.
 *
 * ## Kenapa ini ada, dan kenapa tidak cukup di `INSTRUCTION_BLOCKS`
 *
 * Aturan di `instructions` dibaca SEKALI di awal sesi. Yang bocor bukan
 * pengetahuannya melainkan perhatiannya: aturan tombol terlupa justru pada
 * giliran yang pekerjaan utamanya hal lain, saat pertanyaannya menempel di
 * ekor sebagai penutup -- dan giliran padat adalah giliran yang paling jauh
 * dari bacaan awal sesi. Terukur tiga kali dalam satu sesi yang seluruh isinya
 * membahas tombol (spec 2026-08-11, T-8), ketiganya ditangkap user.
 *
 * Bentuk ini BUKAN gagasan baru. Sistem lama memakainya untuk aturan yang sama
 * persis, dan docstring-nya menyebut alasan yang sama: "re-injects the ambient
 * Telegram-channel obligations every turn (not just at SessionStart), so they
 * don't fade under task pressure". MCP `instructions` sistem lama sengaja tidak
 * menyebut tombol sama sekali -- penempatan di hook adalah pilihan sadar
 * perancangnya, bukan kelalaian yang kebetulan menolong.
 *
 * ## Kenapa BUKAN `engine/reminders.ts`
 *
 * Berkas itu punya syarat masuk: "kapan ia TIDAK menyala?" Pengingat ini
 * menyala di hampir setiap giliran Telegram, jadi ia gagal ujian itu. Tapi
 * doktrin tersebut menjaga SATU KANAL tertentu -- `[from: system]` -- dari
 * menjadi latar belakang. Hook ini menulis ke `additionalContext`, kanal yang
 * berbeda dan tidak ikut mendorong isi ke sana, jadi ambangnya tidak mengotori
 * kanal yang doktrin itu lindungi.
 *
 * ## Hanya `node:` yang boleh diimpor
 *
 * Bukan gaya: versi pertama `hooks/session-start.ts` yang mengimpor modul
 * engine tidak pernah menyala sama sekali padahal terlihat terpasang. Karena
 * itu rule-id di bawah adalah SALINAN, dan yang menutup jaraknya dengan
 * `RULE_IDS` di `src/server.ts` adalah sebuah test, bukan sebuah import.
 */
import { readFileSync } from "node:fs";

/** Cara Claude Code menamai server MCP plugin ini. */
const PLUGIN_ID = "cc-plugin";

/** Salinan sengaja dari `src/server.ts`. Diadu oleh test dengan `RULE_IDS`. */
export const RULE_BUTTONS_WHEN_PICKABLE = "buttons-when-pickable";

/** Salinan sengaja dari `src/server.ts`, alasan yang sama. */
export const AGENT_TURN_MARKER = "[from: agent]";

/**
 * `null` berarti tidak ada yang disuntik — bukan string kosong, karena blok
 * kosong tetap dibayar tokennya dan mengajari AI bahwa penanda itu kadang tidak
 * berarti apa-apa.
 *
 * Dua gerbang, dan urutannya tidak penting karena keduanya menolak, bukan
 * memilih. Yang penting keduanya ADA: pengecualian yang dipasang di satu
 * penanda saja adalah pengecualian yang menjaga pintu sambil membuka jendela.
 */
export function buildTurnReminder(prompt: string): string | null {
  // Sinyalnya harus menyebut plugin INI, bukan sekadar "ada channel": satu sesi
  // bisa punya plugin ini DAN plugin telegram lama tersambung sekaligus.
  //
  // `reply-guard` punya dua sinyal, `origin.server` atau regex tag ini. Hook
  // UserPromptSubmit hanya menerima { prompt }, tanpa transcript, jadi hanya
  // yang kedua tersedia di sini. Konsekuensinya: prompt yang cuma MENYEBUT tag
  // itu ikut menyalakannya. Diterima sadar -- hook ini tidak memblokir apa pun,
  // jadi harganya satu baris, bukan giliran yang mati.
  if (!new RegExp(`<channel[^>]*source="[^"]*${PLUGIN_ID}`).test(prompt)) return null;

  // Giliran antar-bot tidak boleh dijawab dengan `reply` sama sekali (aturan
  // `inter-bot-channel`), jadi mengingatkan soal tombol di sana adalah
  // menyuruh melakukan hal yang aturan lain melarang.
  if (prompt.includes(AGENT_TURN_MARKER)) return null;

  // Menyebut TOOL dan PARAMETERnya, bukan cuma tindakannya. Pelajaran
  // `name-session`: pengingat yang menyuruh sebuah tindakan tanpa menyebut
  // alatnya membuat bot uji membaca source code repo sebelum menemukan
  // tool-nya. "AI pasti tahu caranya" adalah asumsi yang sudah terbukti salah
  // sekali di repo ini.
  return (
    `Rule \`${RULE_BUTTONS_WHEN_PICKABLE}\` for THIS turn: if the answer you want can be picked ` +
    `from a short list -- a confirmation, or a menu of 2-4 named options -- attach the ` +
    `\`buttons\` parameter to your \`reply\` call. If its real answer is prose, send it without ` +
    `buttons. The engine appends the escape hatch itself; never write that one yourself.`
  );
}

function main(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  let prompt = "";
  try {
    // BOM dibuang dengan cara yang sama seperti `parseHookInput` di
    // reply-guard: satu byte tak terlihat di depan sudah cukup membuat
    // JSON.parse gagal, dan hook yang gagal parse adalah hook yang mati bisu.
    prompt = JSON.parse(raw.replace(/^﻿/, ""))?.prompt ?? "";
  } catch {
    return;
  }
  if (typeof prompt !== "string") return;

  const reminder = buildTurnReminder(prompt);
  if (reminder === null) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: reminder,
      },
    })
  );
}

if (import.meta.main) main();
```

- [ ] **Step 4: Jalankan test, pastikan HIJAU**

Run: `cd cc-plugin && bun test test/turn-reminder.test.ts`
Expected: PASS, 6 test.

- [ ] **Step 5: Daftarkan hook-nya**

Tanpa langkah ini berkasnya benar dan tidak pernah dipanggil. Ubah `cc-plugin/hooks/hooks.json` menjadi:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.ts\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"${CLAUDE_PLUGIN_ROOT}/hooks/turn-reminder.ts\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"${CLAUDE_PLUGIN_ROOT}/hooks/reply-guard.ts\""
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Buktikan hook-nya benar-benar jalan sebagai proses, bukan cuma sebagai fungsi**

Test di Step 1 menguji `buildTurnReminder`, bukan berkasnya sebagai hook. Jalankan berkasnya seperti Claude Code menjalankannya:

```bash
cd cc-plugin && echo '{"prompt":"<channel source=\"plugin:cc-plugin:cc-plugin\">[from: user]\nhalo</channel>"}' | bun run hooks/turn-reminder.ts
```

Expected: satu baris JSON yang memuat `"hookEventName":"UserPromptSubmit"` dan kalimat aturannya.

Lalu pastikan ia bisu di giliran antar-bot:

```bash
cd cc-plugin && echo '{"prompt":"<channel source=\"plugin:cc-plugin:cc-plugin\">[from: agent]\nhalo</channel>"}' | bun run hooks/turn-reminder.ts
```

Expected: **tidak ada keluaran sama sekali.**

- [ ] **Step 7: Jalankan seluruh test + typecheck**

Run: `cd cc-plugin && bun test && bunx tsc --noEmit`
Expected: 745 pass, 0 fail. `tsc` bersih.

- [ ] **Step 8: Commit**

```bash
git add cc-plugin/hooks/turn-reminder.ts cc-plugin/hooks/hooks.json cc-plugin/test/turn-reminder.test.ts
git commit -m "feat(cc-plugin): aturan tombol disuntik ulang tiap giliran Telegram

Slot UserPromptSubmit sebelumnya kosong; sistem lama justru menaruh aturan
tombol di sana, dan MCP instructions-nya sengaja tidak menyebut tombol sama
sekali. Docstring hook lama menyebut alasannya: aturan yang dibaca sekali di
awal sesi memudar di bawah tekanan pekerjaan.

Hook DIAM pada giliran antar-bot -- aturan inter-bot-channel melarang reply
di sana, jadi mengingatkan soal tombol berarti menyuruh melakukan hal yang
aturan lain larang.

Rule-id dieja sebagai literal karena hook cuma boleh mengimpor node:, dan
jaraknya ditutup test yang mengadunya dengan RULE_IDS.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Naikkan versi dan verifikasi seluruhnya

**Files:**
- Modify: `cc-plugin/.claude-plugin/plugin.json` (baris 4)
- Modify: `cc-plugin/package.json` (baris 3)

**Interfaces:**
- Consumes: seluruh hasil Task 1-4.
- Produces: versi `0.44.0`.

- [ ] **Step 1: Pastikan `formatSendResult` benar-benar tidak tersentuh**

Rancangan yang menambahkan klausa `asked without buttons` di sana sudah dibatalkan (spec K-9). Langkah ini memastikan pembatalannya utuh, bukan tertinggal setengah.

Run: `cd cc-plugin && git diff main -- src/server.ts | grep -n "formatSendResult\|asked without buttons" || echo "BERSIH"`
Expected: `BERSIH`. Kalau ada yang muncul, buang perubahannya — `src/server.ts` hanya boleh berubah di `INSTRUCTION_BLOCKS`.

- [ ] **Step 2: Naikkan versi di dua tempat**

Keduanya, bukan salah satu — commit `c3e00b1` mengubah dua berkas ini bersama, dan versi yang menyimpang antara keduanya adalah kegagalan diam.

Di `cc-plugin/.claude-plugin/plugin.json` baris 4 dan `cc-plugin/package.json` baris 3, ubah `"version": "0.43.0"` menjadi `"version": "0.44.0"`.

- [ ] **Step 3: Verifikasi penuh**

Run: `cd cc-plugin && bun test && bunx tsc --noEmit`
Expected: 745 pass, 0 fail (725 baseline + 20 baru), `tsc` tanpa keluaran.

Angka `745` adalah perkiraan dari jumlah test yang plan ini tulis (9 + 2 + 3 + 6 = 20). Yang WAJIB benar adalah `0 fail` dan bahwa 725 test baseline semuanya masih ada. Kalau totalnya berbeda karena satu test dipecah atau digabung saat implementasi, itu bukan kegagalan — tapi total yang lebih KECIL dari 725 adalah kegagalan.

- [ ] **Step 4: Commit**

```bash
git add cc-plugin/.claude-plugin/plugin.json cc-plugin/package.json
git commit -m "chore(cc-plugin): 0.44.0

Tombol jalan keluar yang diinjeksi mesin, dua aturan bernama, dan hook
per giliran. Spec: docs/2026-08-11-tombol-fallback-manual-spec.md

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Uji hidup — satu-satunya yang tidak bisa dibuktikan test**

`bun test` tidak pernah membuktikan bahwa keyboard mendarat benar di HP, atau bahwa hook benar-benar dipanggil Claude Code. Serahkan ke user dengan tiga hal yang harus dilihat:

1. Kirim satu balasan bertombol dari sesi yang memakai versi baru → keyboard di HP punya baris `✏️ Explain manually` di paling bawah, yang **tidak** ditulis AI.
2. Tap tombol itu → pesannya berubah menjadi `→ let me explain manually instead`, dan balasan berikutnya datang **tanpa tombol**.
3. Giliran sesudahnya kembali menawarkan tombol seperti biasa (aturan `manual-fallback-tap` mengikat satu balasan saja, bukan seterusnya).

Catat hasilnya. Kalau nomor 1 gagal, kandidat pertama bukan `withManualFallback` melainkan apakah versi `0.44.0` sudah benar-benar terpasang di folder bot itu.

---

## Catatan penyimpangan dari spec

Satu, dan disebut supaya tidak terlihat seperti kelalaian:

**Spec K-3 menulis `MANUAL_FALLBACK_BUTTON` dengan `as const`; plan ini memakai anotasi `: Button`.** Keduanya berjalan, dan blok kode di spec bersifat ilustratif. `: Button` dipilih supaya konstanta itu langsung terikat pada tipe yang sama yang dipakai `ButtonRow`, sehingga salah tulis field tertangkap di tempatnya dideklarasikan, bukan di tempat ia dipakai.
