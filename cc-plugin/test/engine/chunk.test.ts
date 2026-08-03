import { expect, test } from "bun:test";
import { balanceFences, chunkRaw, planParts, TELEGRAM_MAX_CHARS, CHUNK_MARGIN } from "../../src/engine/chunk";
import { commonMarkToMarkdownV2 } from "../../src/engine/markdown";

test("teks pendek tidak disentuh sama sekali", () => {
  expect(chunkRaw("halo", 100)).toEqual(["halo"]);
});

test("memotong di batas paragraf, bukan di tengah kalimat", () => {
  const a = "a".repeat(60);
  const b = "b".repeat(60);
  const parts = chunkRaw(`${a}\n\n${b}`, 80);
  expect(parts.length).toBe(2);
  expect(parts[0]).toBe(a);
  expect(parts[1]).toBe(b);
});

test("jatuh ke baris tunggal kalau tidak ada baris kosong", () => {
  const a = "a".repeat(60);
  const b = "b".repeat(60);
  const parts = chunkRaw(`${a}\n${b}`, 80);
  expect(parts[0]).toBe(a);
  expect(parts[1]).toBe(b);
});

// Tanpa batas yang layak, potong keras. Yang TIDAK boleh terjadi: hilang.
test("tanpa batas apa pun, potong keras dan tidak ada yang hilang", () => {
  const solid = "x".repeat(250);
  const parts = chunkRaw(solid, 100);
  expect(parts.length).toBe(3);
  expect(parts.join("")).toBe(solid);
});

// Properti yang paling menjaga: tidak ada isi yang boleh menguap. Satu test ini
// yang mencegah "perbaikan" yang diam-diam membuang teks -- cara yang sama
// dipakai menjaga W-21.
test("gabungan seluruh potongan memuat seluruh isi aslinya", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Paragraf ${i} ${"y".repeat(80)}`).join("\n\n");
  const parts = chunkRaw(text, 300);
  const strip = (s: string) => s.replace(/\s+/g, "");
  expect(parts.map(strip).join("")).toBe(strip(text));
});

test("potongan kerdil ditolak: kandidat batas harus melewati setengah jendela", () => {
  // Baris kosong di posisi 5 -- jauh di bawah setengah dari limit 100, jadi
  // memakainya akan menghasilkan potongan 5 karakter dan ledakan jumlah pesan.
  const text = `short\n\n${"z".repeat(300)}`;
  const parts = chunkRaw(text, 100);
  expect(parts[0]!.length).toBeGreaterThan(50);
});

test("jalur cepat: yang muat setelah dikonversi tetap satu potongan", () => {
  const text = "halo **bro**";
  const parts = planParts(text);
  expect(parts.length).toBe(1);
  expect(parts[0]!.mv2).toBe(true);
  expect(parts[0]!.raw).toBe(text);
  // Janjinya bukan "mengandung kata yang benar" tapi "identik byte demi byte
  // dengan yang dulu dikirim sebelum chunking ada" -- itu cuma bisa dibuktikan
  // dengan kesetaraan penuh terhadap konversi yang sama, bukan substring.
  expect(parts[0]!.wire).toBe(commonMarkToMarkdownV2(text));
});

test("yang tidak muat dipecah, dan tiap potongan dikonversi sendiri", () => {
  const text = Array.from({ length: 200 }, (_, i) => `Baris ${i} ${"k".repeat(60)}`).join("\n\n");
  const parts = planParts(text);
  expect(parts.length).toBeGreaterThan(1);
  for (const p of parts) expect(p.wire.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
});

test("konstanta batasnya eksplisit, bukan angka ajaib yang tersebar", () => {
  expect(TELEGRAM_MAX_CHARS).toBe(4096);
  expect(CHUNK_MARGIN).toBe(2048);
});

// Cabang mv2:false (chunk.ts:76-78) sebelumnya nol test, dan bukan cabang
// teoretis: pada 2026-08-02 sebuah tabel markdown nyata membengkak lewat
// escaping MarkdownV2 dan produksi mengirimnya mentah. Kolom lebar memaksa
// baris pemisah "| --- |" ikut melebar jadi tanda hubung sepanjang kolom, dan
// setiap tanda hubung di-escape jadi dua karakter -- itu yang membuat rasio
// pembengkakan tabel jauh di atas teks biasa (terukur ~2.27x, kadang lebih
// untuk kolom lebar) dan cukup untuk membuat satu potongan 2048-karakter
// MENTAH menjadi lebih dari 4096 karakter setelah dikonversi.
test("tabel markdown yang lebar memicu fallback teks polos (W: insiden 2026-08-02)", () => {
  const header =
    "| Kolom-Pertama-Panjang | Kolom-Kedua-Panjang | Kolom-Ketiga-Panjang | Kolom-Keempat-Panjang |\n";
  const sep = "| --- | --- | --- | --- |\n";
  let table = header + sep;
  let i = 0;
  while (table.length < 6500) {
    table += `| A-${i} | B-${i} | C-${i} | D-${i} |\n`;
    i++;
  }

  const parts = planParts(table);

  const plainParts = parts.filter((p) => p.mv2 === false);
  expect(plainParts.length).toBeGreaterThan(0);
  // Fallback berarti kirim MENTAH apa adanya -- `wire` yang dikirim ke Telegram
  // harus sama persis dengan `raw` yang disimpan ke riwayat, bukan versi yang
  // sudah (gagal) dikonversi.
  for (const p of plainParts) expect(p.wire).toBe(p.raw);
  // Properti yang paling menjaga: apa pun jalurnya (mv2 true atau false), tidak
  // ada satu potongan pun yang boleh melewati batas keras Telegram.
  for (const p of parts) expect(p.wire.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
});

// W: insiden 2026-08-03 -- tabel 120 baris terbungkus fence dikirim satu
// reply, chunkRaw() memotongnya jadi 5 potongan tanpa tahu-menahu soal fence
// (dan memang tidak boleh, lihat komentar di chunkRaw()). Pembuka mendarat di
// potongan 1, penutup di potongan 5; potongan 5 diparse sendirian dan
// membaca satu ``` kesepian sebagai PEMBUKA, menelan pertanyaan penutup dan
// daftar bernomor jadi blok kode di HP user.
const countFenceLines = (s: string) => s.split("\n").filter((l) => l.trim().startsWith("```")).length;

test("balanceFences: fence yang terbuka di potongan 1 dan tertutup di potongan 3 dijahit ulang", () => {
  const parts = ["before\n```", "line in fence", "```\nafter"];
  const balanced = balanceFences(parts);

  expect(balanced.length).toBe(3);
  for (const p of balanced) expect(countFenceLines(p) % 2).toBe(0);

  expect(balanced[0]).toBe("before\n```\n```");
  expect(balanced[1]).toBe("```\nline in fence\n```");
  expect(balanced[2]).toBe("```\n```\nafter");
});

test("balanceFences: info string bahasa dipertahankan saat fence dibuka ulang, penutup tambahan polos", () => {
  const parts = ["before\n```ts", "code line", "```\nafter"];
  const balanced = balanceFences(parts);

  // Potongan 1 tidak punya penutup sendiri -- yang ditambahkan harus polos,
  // bukan membawa "ts" ikut serta.
  expect(balanced[0]).toBe("before\n```ts\n```");
  // Potongan 2 dibuka ulang dengan tag bahasa yang sama persis.
  expect(balanced[1]).toBe("```ts\ncode line\n```");
  expect(balanced[2]).toBe("```ts\n```\nafter");
});

test("balanceFences: potongan tanpa fence sama sekali kembali persis sama", () => {
  const parts = ["halo dunia", "paragraf kedua\n\nparagraf ketiga", "baris terakhir tanpa backtick"];
  expect(balanceFences(parts)).toEqual(parts);
});

test("balanceFences lewat planParts: fence panjang tidak menelan teks setelahnya (W: insiden 2026-08-03)", () => {
  const rows = Array.from(
    { length: 200 },
    (_, i) => `| No ${i} | Kode-${i} | Keterangan baris nomor ${i} yang agak panjang |`,
  ).join("\n");
  const text =
    `Tabel 120 baris, satu panggilan reply saja\n\n\`\`\`\n${rows}\n\`\`\`\n\n` +
    `Mau lihat detail baris yang mana?\n\n1. Baris 34 ...\n`;

  const parts = planParts(text);
  expect(parts.length).toBeGreaterThanOrEqual(3);

  for (const p of parts) expect(countFenceLines(p.raw) % 2).toBe(0);

  const questionPart = parts.find((p) => p.raw.includes("Mau lihat detail"));
  expect(questionPart).toBeDefined();

  let open = false;
  for (const line of questionPart!.raw.split("\n")) {
    if (line.trim().startsWith("```")) open = !open;
    if (line.includes("Mau lihat detail")) {
      expect(open).toBe(false);
      break;
    }
  }
});
