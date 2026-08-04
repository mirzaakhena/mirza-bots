import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurrentSessionId } from "../../src/engine/session-file";
import { sessionIdPathIn } from "../../src/engine/paths";

function botHome(): string {
  return mkdtempSync(join(tmpdir(), "sess-"));
}

test("reads the id the SessionStart hook last wrote", () => {
  const home = botHome();
  writeFileSync(sessionIdPathIn(home), "18e75c98-c4ee-4737-b365-911d36e9940d");

  expect(readCurrentSessionId(home)).toBe("18e75c98-c4ee-4737-b365-911d36e9940d");
});

// Absent means unknown, and unknown must stay undefined. A stale or invented id
// is worse than none: an empty column says "don't know", a wrong one says
// "know, and here it is" -- and nobody ever gets suspicious of the second.
// Same failure class as the `listening` line that lied (W-4).
test("no file means undefined, never a guess", () => {
  expect(readCurrentSessionId(botHome())).toBeUndefined();
});

test("an empty or whitespace-only file is treated as absent", () => {
  const home = botHome();
  writeFileSync(sessionIdPathIn(home), "   \n");

  expect(readCurrentSessionId(home)).toBeUndefined();
});

// Dulu test ini berbunyi "one bot's id is never served for another", dan
// dijaga oleh nama berkas <bot>.id di folder bersama. Isolasinya sekarang
// struktural: dua bot adalah dua folder, jadi tidak ada satu berkas pun yang
// bisa keliru dibaca. Yang dikunci: folder lain tidak menjawab apa pun.
test("folder bot lain tidak menyumbang jawaban apa pun", () => {
  const satu = botHome();
  const dua = botHome();
  writeFileSync(sessionIdPathIn(satu), "aaa");

  expect(readCurrentSessionId(dua)).toBeUndefined();
});

// The point of reading per call rather than capturing once: /clear replaces the
// file's contents while the engine process keeps running, and the next push must
// see the new value.
test("picks up a newly written id without anything being restarted", () => {
  const home = botHome();
  writeFileSync(sessionIdPathIn(home), "05b5ed06");
  expect(readCurrentSessionId(home)).toBe("05b5ed06");

  writeFileSync(sessionIdPathIn(home), "18e75c98");
  expect(readCurrentSessionId(home)).toBe("18e75c98");
});
