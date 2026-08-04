import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHookInput, sessionIdFrom, isBotFolder, botNameOf } from "../../hooks/session-start";

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
