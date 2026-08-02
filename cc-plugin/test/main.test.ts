import { describe, test, expect } from "bun:test";
import { resolveIdentityCwd, resolveSessionId } from "../src/main";

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

describe("resolveSessionId", () => {
  test("returns CLAUDE_CODE_SESSION_ID when Claude Code sets it", () => {
    const prev = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "a3760589-1111-2222-3333-444444444444";
    try {
      expect(resolveSessionId()).toBe("a3760589-1111-2222-3333-444444444444");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prev;
    }
  });

  test("returns undefined when it is unset or empty, so hello omits the field", () => {
    const prev = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    try {
      expect(resolveSessionId()).toBeUndefined();
      process.env.CLAUDE_CODE_SESSION_ID = "";
      // An empty env var is "not set" in every way that matters -- storing "" in
      // session_id would look like a real session id to every later query.
      expect(resolveSessionId()).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prev;
    }
  });
});
