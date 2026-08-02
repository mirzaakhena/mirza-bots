import { describe, test, expect } from "bun:test";
import { resolveIdentityCwd } from "../src/main";

describe("resolveIdentityCwd", () => {
  test("prefers CLAUDE_PROJECT_DIR when Claude Code sets it", () => {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "/Users/mirza/Workspace/some-project";
    try {
      expect(resolveIdentityCwd()).toBe("/Users/mirza/Workspace/some-project");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
  });

  test("falls back to process.cwd() when CLAUDE_PROJECT_DIR is unset", () => {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      expect(resolveIdentityCwd()).toBe(process.cwd());
    } finally {
      if (prev !== undefined) process.env.CLAUDE_PROJECT_DIR = prev;
    }
  });
});

