import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHookInput,
  sessionIdFrom,
  isBotFolder,
  botNameOf,
  runHook,
} from "../../hooks/session-start";

test("prefers the session id in the hook payload", () => {
  expect(
    sessionIdFrom({ session_id: "from-payload" }, { CLAUDE_CODE_SESSION_ID: "from-env" } as any)
  ).toBe("from-payload");
});

test("falls back to the env var when the payload carries none", () => {
  expect(sessionIdFrom({}, { CLAUDE_CODE_SESSION_ID: "from-env" } as any)).toBe("from-env");
});

// Writing nothing is correct here: a missing id must leave the previous value
// alone rather than blank it, because "don't know" and "no session" are
// different things and only one of them is true.
test("returns undefined when neither exists, so nothing is written", () => {
  expect(sessionIdFrom({}, {} as any)).toBeUndefined();
});

test("an empty string counts as absent, not as a session named ''", () => {
  expect(sessionIdFrom({ session_id: "" }, { CLAUDE_CODE_SESSION_ID: "" } as any)).toBeUndefined();
});

// Third BOM incident in this project (SCAR-026): one invisible byte made
// JSON.parse throw, main() return early, and a hook stay perfectly installed
// while guarding nothing at all.
test("tolerates a leading BOM instead of throwing", () => {
  expect(parseHookInput('\ufeff{"session_id":"x"}')).toEqual({ session_id: "x" });
});

test("returns null for genuinely malformed input rather than throwing", () => {
  expect(parseHookInput("{ not json")).toBeNull();
});

// Measured on the real hook 2026-08-02: the payload names why it fired. Kept in
// a test so a future change that drops the field is noticed here rather than in
// a behaviour nobody is watching.
test("reads the id from a real /clear payload shape", () => {
  const payload = parseHookInput(
    JSON.stringify({
      session_id: "18e75c98-c4ee-4737-b365-911d36e9940d",
      cwd: "C:\\Users\\Mirza\\workspace\\bot-uji",
      hook_event_name: "SessionStart",
      source: "clear",
    })
  );

  expect(sessionIdFrom(payload, {} as any)).toBe("18e75c98-c4ee-4737-b365-911d36e9940d");
});

// Dulu di sini ada `botForCwd`, yang membaca daftar `bots` dari config.json dan
// mencocokkan `home` tiap entri ke cwd -- termasuk seluruh perkara normalisasi
// separator yang pernah membuat sebuah bot tidak mengenali rumahnya sendiri
// (kegagalan 2026-08-02: CC memberi forward slash, config menyimpan backslash).
//
// Sesudah state per-folder, pertanyaan itu tidak punya bentuk lagi: cwd ADALAH
// botnya. Yang tersisa cuma "apakah folder ini bot" -- keberadaan sebuah berkas,
// yang tidak bisa salah cocok. Sekelas bug hilang bersama pertanyaannya.
function tempFolder(name: string, withConfig: boolean): string {
  const home = join(mkdtempSync(join(tmpdir(), "hook-")), name);
  mkdirSync(home, { recursive: true });
  if (withConfig) writeFileSync(join(home, "config.json"), "{}");
  return home;
}

test("folder dengan config.json adalah bot, dan namanya nama folder", () => {
  const home = tempFolder("mirza_01_bot", true);

  expect(isBotFolder(home)).toBe(true);
  expect(botNameOf(home)).toBe("mirza_01_bot");
});

// Bukan folder bot berarti hook diam: mengeluh di sini akan berteriak di setiap
// project lain yang user buka, dan itu cara sinyal berguna berubah jadi bising
// yang orang saring.
test("folder tanpa config.json bukan bot", () => {
  expect(isBotFolder(tempFolder("bukan-bot", false))).toBe(false);
});

test("separator dan trailing slash tidak mengubah nama bot", () => {
  expect(botNameOf("C:\\Users\\Mirza\\workspace\\bot-uji")).toBe("bot-uji");
  expect(botNameOf("C:/Users/Mirza/workspace/bot-uji/")).toBe("bot-uji");
});

describe("runHook: folder yang bukan bot tidak disentuh sama sekali", () => {
  // Terukur di workspace nyata 2026-08-10: bot-01..bot-06 punya
  // logs/session-hook.log padahal tidak satu pun punya config.json. Sebabnya
  // urutan -- `note(cwd, "fired")` dipanggil SEBELUM folder itu diperiksa, dan
  // `note` sendiri melakukan mkdirSync. Jadi berkasnya lahir sebelum ada yang
  // tahu folder itu bot atau bukan.
  //
  // Komentar di berkas hook-nya sendiri sudah menyatakan niat yang berlawanan:
  // "saying so here would mean shouting in every unrelated project the user
  // opens". Niatnya benar; yang bocor berkasnya.
  function spies() {
    const notes: string[] = [];
    const writes: Array<{ path: string; id: string }> = [];
    return {
      notes,
      writes,
      note: (line: string) => notes.push(line),
      writeSessionId: (path: string, id: string) => writes.push({ path, id }),
    };
  }

  test("tidak mencatat apa pun, dan tidak membaca stdin", () => {
    const s = spies();
    let stdinReads = 0;

    runHook({
      cwd: tempFolder("project-orang-lain", false),
      readStdin: () => {
        stdinReads++;
        return JSON.stringify({ session_id: "abc" });
      },
      env: {} as any,
      note: s.note,
      writeSessionId: s.writeSessionId,
    });

    expect(s.notes).toEqual([]);
    expect(s.writes).toEqual([]);
    expect(stdinReads).toBe(0);
  });

  test("folder bot mencatat dan menulis session.id", () => {
    const s = spies();
    const home = tempFolder("mirza_01_bot", true);

    runHook({
      cwd: home,
      readStdin: () => JSON.stringify({ session_id: "abc-123", source: "clear" }),
      env: {} as any,
      note: s.note,
      writeSessionId: s.writeSessionId,
    });

    expect(s.writes).toEqual([{ path: join(home, "session.id"), id: "abc-123" }]);
    expect(s.notes.length).toBeGreaterThan(0);
  });

  test("folder bot tanpa session id tetap MENINGGALKAN jejak, dan tidak menulis", () => {
    // Di sinilah "fired" berguna: bot folder yang gagal harus bisa dibedakan
    // dari hook yang tidak pernah menyala.
    const s = spies();

    runHook({
      cwd: tempFolder("mirza_01_bot", true),
      readStdin: () => "{}",
      env: {} as any,
      note: s.note,
      writeSessionId: s.writeSessionId,
    });

    expect(s.writes).toEqual([]);
    expect(s.notes.length).toBeGreaterThan(0);
  });
});
