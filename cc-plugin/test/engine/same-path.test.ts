import { expect, test } from "bun:test";
import { samePath, normalizePath } from "../../src/engine/same-path";

// The exact pair measured on 2026-08-02. Claude Code hands the SessionStart hook
// forward slashes and the MCP server backslashes; config.json holds one of them.
// Compared as raw text, a bot never recognised its own home.
test("a Windows path spelled with forward slashes matches the same path with backslashes", () => {
  expect(
    samePath("C:/Users/Mirza/workspace/bot-uji", "C:\\Users\\Mirza\\workspace\\bot-uji")
  ).toBe(true);
});

test("a trailing separator does not make a directory different from itself", () => {
  expect(samePath("C:/Users/Mirza/workspace/bot-uji/", "C:\\Users\\Mirza\\workspace\\bot-uji")).toBe(
    true
  );
  expect(samePath("/home/mirza/bot", "/home/mirza/bot/")).toBe(true);
});

test("genuinely different directories still do not match", () => {
  expect(samePath("C:/Users/Mirza/workspace/bot-uji", "C:/Users/Mirza/workspace/bot-01")).toBe(
    false
  );
  expect(samePath("/home/mirza/bot", "/home/mirza/bot2")).toBe(false);
});

// Case is left alone on purpose. Windows would call these the same and Linux
// would not, and answering "same" for two different directories is worse than
// missing a match -- a missed match shows up in the log, a wrong one does not.
test("case is not folded, because on some platforms it is a real difference", () => {
  expect(samePath("C:/Users/Mirza/BOT", "C:/Users/Mirza/bot")).toBe(false);
});

test("a root path is not emptied by trailing-separator trimming", () => {
  expect(normalizePath("/")).toBe("/");
  expect(normalizePath("C:\\")).toBe("C:/");
});
