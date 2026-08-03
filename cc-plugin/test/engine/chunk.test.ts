import { expect, test } from "bun:test";
import { chunkRaw, planParts, TELEGRAM_MAX_CHARS, CHUNK_MARGIN } from "../../src/engine/chunk";

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
  const parts = planParts("halo **bro**");
  expect(parts.length).toBe(1);
  expect(parts[0]!.mv2).toBe(true);
  expect(parts[0]!.raw).toBe("halo **bro**");
  expect(parts[0]!.wire).toContain("bro");
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
