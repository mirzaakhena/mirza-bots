import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionNameFromTranscript } from "../../../src/engine/context/session-title";

const SID = "d93c0363-03ee-44b6-8a89-5beb41d3d099";
const LAIN = "99f8995f-f812-4179-82de-76c1df39dcbf";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "transcript-"));
}

/** Menulis transcript untuk `sid` di `dir`, mengembalikan path berkasnya. */
function transcript(dir: string, sid: string, lines: string[]): string {
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function title(name: string, sid: string = SID): string {
  return JSON.stringify({ type: "custom-title", customTitle: name, sessionId: sid });
}

describe("readSessionNameFromTranscript", () => {
  test("mengembalikan custom-title TERAKHIR, bukan yang pertama", () => {
    const dir = scratch();
    const p = transcript(dir, SID, [
      title("ngobrol-santai"),
      JSON.stringify({ type: "user", timestamp: "2026-08-07T00:00:00.000Z" }),
      title("belajar-python-app"),
      title("coba-notif"),
    ]);
    expect(readSessionNameFromTranscript(p, SID)).toBe("coba-notif");
  });

  // Inti perbaikannya. `transcript_path` di status.json boleh menunjuk sesi yang
  // sudah lewat -- yang tetap benar cuma DIREKTORInya, karena semua sesi bot itu
  // tinggal di folder yang sama. Identitas sesi dijamin NAMA BERKAS, bukan
  // perbandingan field yang bisa berbohong.
  test("memakai direktori dari path basi, berkasnya dari session id yang segar", () => {
    const dir = scratch();
    transcript(dir, LAIN, [title("uji-engine-mati", LAIN)]);
    transcript(dir, SID, [title("coba-notif")]);
    const pathBasi = join(dir, `${LAIN}.jsonl`);
    expect(readSessionNameFromTranscript(pathBasi, SID)).toBe("coba-notif");
  });

  test("custom-title milik sesi lain di berkas yang sama diabaikan", () => {
    const dir = scratch();
    const p = transcript(dir, SID, [title("coba-notif"), title("punya-tetangga", LAIN)]);
    expect(readSessionNameFromTranscript(p, SID)).toBe("coba-notif");
  });

  test("transcript tanpa custom-title -> null, artinya belum pernah dinamai", () => {
    const dir = scratch();
    const p = transcript(dir, SID, [
      JSON.stringify({ type: "user", timestamp: "2026-08-07T00:00:00.000Z" }),
    ]);
    expect(readSessionNameFromTranscript(p, SID)).toBeNull();
  });

  test("berkas transcript tidak ada -> null, bukan melempar", () => {
    const dir = scratch();
    expect(readSessionNameFromTranscript(join(dir, `${LAIN}.jsonl`), SID)).toBeNull();
  });

  // Transcript ditulis Claude Code sambil berjalan; baris terakhir bisa tertangkap
  // setengah tertulis. Satu baris rusak tidak boleh membuat seluruh nama hilang.
  test("baris rusak dilewati, baris sehat sebelumnya tetap terbaca", () => {
    const dir = scratch();
    const p = transcript(dir, SID, [title("coba-notif"), '{"type":"custom-tit']);
    expect(readSessionNameFromTranscript(p, SID)).toBe("coba-notif");
  });

  test("transcript_path kosong atau tidak ada -> null", () => {
    expect(readSessionNameFromTranscript(undefined, SID)).toBeNull();
    expect(readSessionNameFromTranscript("", SID)).toBeNull();
  });
});
