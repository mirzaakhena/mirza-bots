import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions } from "../../src/engine/sessions";

/**
 * `sessions.ts` adalah fondasi bersama `/branch` dan `/switch`. Kalau ia salah
 * membaca, dua fitur salah sekaligus -- dan salahnya berupa sesi yang hilang
 * dari daftar, yang tidak terlihat seperti kerusakan.
 */

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "sessions-"));
}

function writeTranscript(d: string, id: string, lines: unknown[], mtimeSec?: number): void {
  const p = join(d, `${id}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
}

test("direktori yang tidak ada dijawab [] -- bot tanpa sesi adalah keadaan sah", () => {
  expect(listSessions(join(tmpdir(), "tidak-ada-sama-sekali-xyz"))).toEqual([]);
});

test("memungut judul TERAKHIR, bukan yang pertama", () => {
  const d = dir();
  writeTranscript(d, UUID_A, [
    { type: "custom-title", sessionId: UUID_A, customTitle: "nama-lama" },
    { type: "user", message: { role: "user", content: "halo" } },
    { type: "custom-title", sessionId: UUID_A, customTitle: "nama-baru" },
  ]);
  expect(listSessions(d)[0]!.title).toBe("nama-baru");
});

test("sesi yang belum pernah di-/rename bertitle null, bukan string kosong", () => {
  const d = dir();
  writeTranscript(d, UUID_A, [{ type: "user", message: { role: "user", content: "halo" } }]);
  expect(listSessions(d)[0]!.title).toBeNull();
});

test("forkedFrom dibaca utuh -- induk DAN titik cabangnya", () => {
  const d = dir();
  writeTranscript(d, UUID_B, [
    { type: "user", forkedFrom: { sessionId: UUID_A, messageUuid: "m-1" } },
  ]);
  expect(listSessions(d)[0]!.forkedFrom).toEqual({ sessionId: UUID_A, messageUuid: "m-1" });
});

test("forkedFrom setengah jadi diabaikan, bukan dipaksa masuk", () => {
  const d = dir();
  writeTranscript(d, UUID_A, [{ type: "user", forkedFrom: { sessionId: UUID_B } }]);
  expect(listSessions(d)[0]!.forkedFrom).toBeNull();
});

// CC bisa sedang menulis sambil kita membaca. Satu baris setengah jadi tidak
// boleh menghapus sebuah sesi dari daftar -- itu kehilangan yang diam-diam.
test("baris JSON rusak dilewati, sesinya tetap terdaftar", () => {
  const d = dir();
  const p = join(d, `${UUID_A}.jsonl`);
  writeFileSync(
    p,
    `{"type":"custom-title","sessionId":"${UUID_A}","customTitle":"utuh"}\n{"type":"custom-title",{rusak\n`,
    "utf8"
  );
  const list = listSessions(d);
  expect(list).toHaveLength(1);
  expect(list[0]!.title).toBe("utuh");
});

test("berkas yang bukan transcript diabaikan", () => {
  const d = dir();
  writeFileSync(join(d, "catatan.txt"), "bukan transcript", "utf8");
  writeFileSync(join(d, "bukan-uuid.jsonl"), "{}", "utf8");
  writeTranscript(d, UUID_A, [{ type: "user" }]);
  expect(listSessions(d).map((s) => s.id)).toEqual([UUID_A]);
});

test("urut mtime, terbaru dulu", () => {
  const d = dir();
  writeTranscript(d, UUID_A, [{ type: "user" }], 1_600_000_000);
  writeTranscript(d, UUID_B, [{ type: "user" }], 1_700_000_000);
  expect(listSessions(d).map((s) => s.id)).toEqual([UUID_B, UUID_A]);
});
