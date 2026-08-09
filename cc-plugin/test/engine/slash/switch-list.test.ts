import { expect, test } from "bun:test";
import { renderSwitchList, MAX_SWITCH_SESSIONS } from "../../../src/engine/slash/switch-list";
import type { SessionInfo } from "../../../src/engine/sessions";

/**
 * `/switch` datar dengan sengaja: satu tombol harus berarti satu sesi yang
 * namanya terlihat. Hierarkinya tinggal di `/branch`.
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

test("menampilkan sesi lintas rumpun, tidak disaring silsilah", () => {
  const out = renderSwitchList([s("a", "rumpun-satu", 10), s("z", "rumpun-lain", 5)], "a", NOW);
  expect(out.text).toContain("rumpun-satu");
  expect(out.text).toContain("rumpun-lain");
  expect(out.ordered).toHaveLength(2);
});

test("sesi berjalan ditandai, bukan disembunyikan", () => {
  const out = renderSwitchList([s("a", "satu", 10), s("b", "dua", 5)], "a", NOW);
  expect(out.text).toContain("← sekarang");
});

// Delapan karena itu batas satu baris tombol Telegram: daftar yang lebih
// panjang dari tombolnya memuat baris yang tidak bisa ditap.
test("dibatasi delapan, dan sisanya DIKATAKAN", () => {
  const many = Array.from({ length: 11 }, (_, i) => s(`id-${i}`, `sesi-${i}`, i));
  const out = renderSwitchList(many, undefined, NOW);
  expect(out.ordered).toHaveLength(MAX_SWITCH_SESSIONS);
  expect(out.text).toContain("(3 sesi lebih lama tidak ditampilkan)");
});

test("sesi yang punya cabang ditandai ⑂", () => {
  const out = renderSwitchList([s("induk", "induk", 20), s("anak", "anak", 5, "induk")], undefined, NOW);
  const baris = out.text.split("\n");
  expect(baris[0]).toContain("induk");
  expect(baris[0]).toContain("⑂");
  expect(baris[1]).toContain("anak");
  expect(baris[1]).not.toContain("⑂");
});

// Cabang yang lahir lama tetap membuat induknya bercabang. Menandainya "tidak
// punya cabang" hanya karena anaknya di luar delapan teratas adalah bohong.
test("penanda cabang dihitung dari SELURUH daftar, bukan dari yang tampil", () => {
  const sessions = [
    s("induk", "induk", 1),
    ...Array.from({ length: 8 }, (_, i) => s(`lain-${i}`, `lain-${i}`, i + 2)),
    s("anak-lama", "anak-lama", 999, "induk"),
  ];
  const out = renderSwitchList(sessions, undefined, NOW);
  expect(out.text.split("\n")[0]).toContain("⑂");
});

test("nama kembar dibedakan id pendek, nama unik tetap bersih", () => {
  const out = renderSwitchList(
    [s("11111111-x", "sama", 10), s("22222222-x", "sama", 5), s("33333333-x", "beda", 1)],
    undefined,
    NOW
  );
  expect(out.text).toContain("sama (11111111)");
  expect(out.text).toContain("sama (22222222)");
  expect(out.text).not.toContain("beda (");
});

test("nol sesi dijawab kalimat", () => {
  expect(renderSwitchList([], undefined, NOW).ordered).toHaveLength(0);
});
