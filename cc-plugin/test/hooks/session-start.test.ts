import { expect, test } from "bun:test";
import { parseHookInput, sessionIdFrom, botForCwd } from "../../hooks/session-start";

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

// botForCwd replaced the engine's zod-validated loader here. The hook needs one
// string out of config.json, and importing the validator is what tied the
// previous version to the engine's whole import graph -- a hook that looked
// installed and did nothing.
// Windows paths on purpose: `home` in the real config.json is a backslash path,
// and the comparison is exact string equality.
const WIN_HOME = "C:\\Users\\Mirza\\workspace\\bot-uji";

test("finds the bot whose home matches the cwd", () => {
  const raw = JSON.stringify({
    allowFrom: ["1"],
    bots: { "bot-uji": { home: WIN_HOME, token: "t" } },
  });

  expect(botForCwd(raw, WIN_HOME)).toBe("bot-uji");
});

test("returns undefined for a directory no bot claims", () => {
  const raw = JSON.stringify({ bots: { "bot-uji": { home: WIN_HOME, token: "t" } } });
  expect(botForCwd(raw, "C:\\Users\\Mirza\\workspace\\bot-99")).toBeUndefined();
});

// Malformed config must make the hook do nothing, not throw: it observes, and an
// observer that crashes is worse than one that stays quiet.
test("malformed config yields undefined instead of throwing", () => {
  expect(botForCwd("{ not json", WIN_HOME)).toBeUndefined();
  expect(botForCwd("{}", WIN_HOME)).toBeUndefined();
});

test("tolerates a BOM on config.json too, not just on the hook payload", () => {
  const raw = "﻿" + JSON.stringify({ bots: { "bot-uji": { home: "/tmp/x", token: "t" } } });
  expect(botForCwd(raw, "/tmp/x")).toBe("bot-uji");
});

// The exact failure from the log, 2026-08-02: Claude Code handed the hook
// forward slashes while config.json held backslashes, and the bot never
// recognised its own home.
test("matches a home written with backslashes against a cwd with forward slashes", () => {
  const raw = JSON.stringify({ bots: { "bot-uji": { home: WIN_HOME, token: "t" } } });
  expect(botForCwd(raw, "C:/Users/Mirza/workspace/bot-uji")).toBe("bot-uji");
});
