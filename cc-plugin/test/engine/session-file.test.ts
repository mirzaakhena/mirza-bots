import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurrentSessionId } from "../../src/engine/session-file";

afterEach(() => {
  delete process.env.MIRZA_BOTS_HOME;
});

function fleetHome(): string {
  const root = mkdtempSync(join(tmpdir(), "sess-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  process.env.MIRZA_BOTS_HOME = root;
  return root;
}

test("reads the id the SessionStart hook last wrote", () => {
  const root = fleetHome();
  writeFileSync(join(root, "sessions", "bot-uji.id"), "18e75c98-c4ee-4737-b365-911d36e9940d");

  expect(readCurrentSessionId("bot-uji")).toBe("18e75c98-c4ee-4737-b365-911d36e9940d");
});

// Absent means unknown, and unknown must stay undefined. A stale or invented id
// is worse than none: an empty column says "don't know", a wrong one says
// "know, and here it is" -- and nobody ever gets suspicious of the second.
// Same failure class as the `listening` line that lied (W-4).
test("no file means undefined, never a guess", () => {
  fleetHome();
  expect(readCurrentSessionId("bot-uji")).toBeUndefined();
});

test("an empty or whitespace-only file is treated as absent", () => {
  const root = fleetHome();
  writeFileSync(join(root, "sessions", "bot-uji.id"), "   \n");

  expect(readCurrentSessionId("bot-uji")).toBeUndefined();
});

test("one bot's id is never served for another", () => {
  const root = fleetHome();
  writeFileSync(join(root, "sessions", "bot-uji.id"), "aaa");

  expect(readCurrentSessionId("bot-01")).toBeUndefined();
});

// The point of reading per call rather than capturing once: /clear replaces the
// file's contents while the engine process keeps running, and the next push must
// see the new value.
test("picks up a newly written id without anything being restarted", () => {
  const root = fleetHome();
  writeFileSync(join(root, "sessions", "bot-uji.id"), "05b5ed06");
  expect(readCurrentSessionId("bot-uji")).toBe("05b5ed06");

  writeFileSync(join(root, "sessions", "bot-uji.id"), "18e75c98");
  expect(readCurrentSessionId("bot-uji")).toBe("18e75c98");
});
