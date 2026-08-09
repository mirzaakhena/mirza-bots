import { expect, test } from "bun:test";
import {
  buildForest,
  flatten,
  labelOf,
  renderBranchTree,
  shortAge,
  treeLines,
  TREE_WIDTH,
} from "../../../src/engine/slash/branch-tree";
import type { SessionInfo } from "../../../src/engine/sessions";

/**
 * Pagar utamanya LEBAR. Terukur di HP user 2026-08-09: Telegram tidak punya
 * scroll horizontal, blok kode dibungkus, dan baris yang terbungkus membuat
 * anak tampak menempel pada induk yang salah. Pohon yang salah lebih buruk
 * daripada pohon yang terpotong.
 */

const NOW = 1_700_000_000_000;

function s(id: string, title: string | null, agoMin: number, parent?: string): SessionInfo {
  return {
    id,
    title,
    mtime: NOW - agoMin * 60_000,
    forkedFrom: parent ? { sessionId: parent, messageUuid: "m" } : null,
  };
}

test("shortAge memendekkan sampai satuan hari", () => {
  expect(shortAge(NOW - 5 * 60_000, NOW)).toBe("5m");
  expect(shortAge(NOW - 130 * 60_000, NOW)).toBe("2j");
  expect(shortAge(NOW - 60 * 60_000 * 30, NOW)).toBe("1h");
});

test("sesi tanpa nama tetap bisa dirujuk lewat id pendeknya", () => {
  expect(labelOf(s("abcdef12-3456-7890-abcd-ef1234567890", null, 1))).toBe("sesi abcdef12");
});

test("forkedFrom menyusun induk-anak", () => {
  const roots = buildForest([s("a", "induk", 10), s("b", "anak", 5, "a")]);
  expect(roots).toHaveLength(1);
  expect(roots[0]!.children[0]!.session.id).toBe("b");
});

// Menghapus transcript induk tidak boleh menghilangkan anaknya dari daftar:
// sesi itu masih bisa dibuka user, dan hilang diam-diam adalah kegagalan
// yang paling mahal.
test("anak yatim diangkat jadi akar, bukan dibuang", () => {
  const roots = buildForest([s("b", "anak", 5, "induk-yang-hilang")]);
  expect(roots.map((r) => r.session.id)).toEqual(["b"]);
});

test("sesi dari /clear jadi akar terpisah -- ini hutan, bukan satu pohon", () => {
  const roots = buildForest([s("a", "satu", 10), s("b", "dua", 5)]);
  expect(roots).toHaveLength(2);
});

test("urutan datar mengikuti urutan baca pohon", () => {
  const roots = buildForest([
    s("a", "induk", 30),
    s("b", "anak1", 20, "a"),
    s("c", "cucu", 10, "b"),
    s("d", "anak2", 5, "a"),
  ]);
  expect(flatten(roots).map((x) => x.title)).toEqual(["induk", "anak1", "cucu", "anak2"]);
});

test("TIDAK ADA baris yang melewati anggaran lebar", () => {
  const roots = buildForest([
    s("a", "nama-induk-yang-sangat-panjang-sekali", 30),
    s("b", "nama-anak-yang-juga-panjang-sekali", 20, "a"),
    s("c", "nama-cucu-yang-panjangnya-keterlaluan", 10, "b"),
  ]);
  for (const line of treeLines(roots, "c")) {
    expect(line.length).toBeLessThanOrEqual(TREE_WIDTH);
  }
});

test("penanda sesi aktif ikut dihitung ke dalam anggaran, bukan ditempel di luar", () => {
  const roots = buildForest([s("a", "nama-yang-panjang-sekali-sekali", 5)]);
  const line = treeLines(roots, "a")[0]!;
  expect(line.endsWith(" <")).toBe(true);
  expect(line.length).toBeLessThanOrEqual(TREE_WIDTH);
});

// `│` hanya sah kalau induknya masih punya adik di bawahnya. Kalau tidak, ia
// garis menggantung yang menunjuk apa-apa.
test("cabang terakhir tidak meninggalkan garis menggantung", () => {
  const roots = buildForest([s("a", "ind", 30), s("b", "ana", 20, "a"), s("c", "cuc", 10, "b")]);
  const lines = treeLines(roots, undefined);
  expect(lines[1]!.startsWith("└ ")).toBe(true);
  expect(lines[2]!.startsWith("  └ ")).toBe(true);
});

test("dua anak: yang pertama pakai ├ dan mewariskan │", () => {
  const roots = buildForest([
    s("a", "ind", 30),
    s("b", "an1", 20, "a"),
    s("c", "cuc", 15, "b"),
    s("d", "an2", 10, "a"),
  ]);
  const lines = treeLines(roots, undefined);
  expect(lines[1]!.startsWith("├ ")).toBe(true);
  expect(lines[2]!.startsWith("│ └ ")).toBe(true);
  expect(lines[3]!.startsWith("└ ")).toBe(true);
});

test("render: bentuk di blok kode, detail lengkap di daftar bernomor", () => {
  const out = renderBranchTree(
    [s("a", "kenalan", 120), s("b", "riset-api-yang-panjang", 40, "a")],
    "b",
    NOW
  );
  // Nama penuh TIDAK boleh hilang: blok kode memotongnya, daftar memulihkannya.
  expect(out).toContain("riset-api-yang-panjang");
  expect(out).toContain("1. kenalan · 2j");
  expect(out).toContain("← sekarang");
  expect(out).toContain("/branch <nama>");
  expect(out.split("```")).toHaveLength(3);
});

test("nol sesi dijawab kalimat, bukan blok kode kosong", () => {
  const out = renderBranchTree([], undefined, NOW);
  expect(out).not.toContain("```");
  expect(out).toContain("/branch <nama>");
});
