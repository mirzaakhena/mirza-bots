import { expect, test } from "bun:test";
import { commonMarkToMarkdownV2 } from "../../src/engine/markdown";

test("bold survives as bold instead of reaching the user as raw asterisks", () => {
  const out = commonMarkToMarkdownV2("**tebal**");
  expect(out).toContain("tebal");
  // The exact marker is the library's business; what matters is that the AI's
  // CommonMark did not travel through untouched, which is what the user saw.
  expect(out).not.toBe("**tebal**");
});

// The reason this module exists at all: MarkdownV2 requires every . - ( ) ! +
// outside markup to be backslash-escaped, or Telegram rejects the WHOLE message
// with a 400. Asking the AI to remember that is exactly what leaked.
test("punctuation that MarkdownV2 reserves comes back escaped", () => {
  const out = commonMarkToMarkdownV2("halo. ini (contoh) - ya!");
  expect(out).toContain("\\.");
  expect(out).toContain("\\(");
  expect(out).toContain("\\-");
  expect(out).toContain("\\!");
});

test("an empty string is not an error", () => {
  expect(commonMarkToMarkdownV2("")).toBe("");
});

test("a fenced code block survives intact", () => {
  const out = commonMarkToMarkdownV2("```\nconst a = 1;\n```");
  expect(out).toContain("const a = 1;");
});

// A real parser, not a regex: text that merely looks like markup must not be
// mangled, and code spans must keep their contents literal.
test("an inline code span keeps its contents literal", () => {
  const out = commonMarkToMarkdownV2("pakai `a.b(c)` ya");
  expect(out).toContain("a.b(c)");
});

// Found live 2026-08-02: the bot's first TWO sends were rejected outright --
// "Character '|' is reserved and must be escaped", then the same for '-'. The
// library's default strategy is `keep`, which passes markdown Telegram has no
// syntax for (tables, thematic breaks) through untouched, and MarkdownV2 then
// rejects the WHOLE message.
test("a markdown table is escaped, not passed through raw", () => {
  const out = commonMarkToMarkdownV2("| a | b |\n|---|---|\n| 1 | 2 |");

  for (let i = 0; i < out.length; i++) {
    if (out[i] === "|") expect(out[i - 1]).toBe("\\");
  }
});

test("a horizontal rule is escaped, not passed through raw", () => {
  const out = commonMarkToMarkdownV2("sebelum\n\n---\n\nsesudah");
  expect(out).toContain("\-");
  expect(out).toContain("sebelum");
  expect(out).toContain("sesudah");
});

// `remove` would also stop the 400 -- by deleting the table entirely, returning
// an empty string for a message the user asked to send. Content that vanishes
// without a word is the exact failure class this project keeps paying for, so
// escaping (ugly but complete) wins over removing (clean but silent).
test("unsupported markdown is kept as text rather than deleted", () => {
  const out = commonMarkToMarkdownV2("| Bahasa | Rilis |\n|---|---|\n| Python | 1991 |");
  expect(out).toContain("Python");
  expect(out).toContain("1991");
  expect(out.length).toBeGreaterThan(0);
});
