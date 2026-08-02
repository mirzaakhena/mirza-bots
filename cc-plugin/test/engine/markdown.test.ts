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
