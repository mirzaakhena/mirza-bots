import { describe, test, expect } from "bun:test";
import { resolveSocketPath, resolveIdentityCwd } from "../src/main";

describe("resolveSocketPath", () => {
  test("honors MIRZA_BOTS_HOME override, same convention as fleetd", () => {
    const prev = process.env.MIRZA_BOTS_HOME;
    process.env.MIRZA_BOTS_HOME = "/tmp/fake-mirza-bots";
    try {
      expect(resolveSocketPath()).toBe("/tmp/fake-mirza-bots/fleetd.sock");
    } finally {
      if (prev === undefined) delete process.env.MIRZA_BOTS_HOME;
      else process.env.MIRZA_BOTS_HOME = prev;
    }
  });

  test("falls back to ~/.claude/mirza-bots/fleetd.sock when unset", () => {
    const prev = process.env.MIRZA_BOTS_HOME;
    delete process.env.MIRZA_BOTS_HOME;
    try {
      const home = require("node:os").homedir();
      expect(resolveSocketPath()).toBe(`${home}/.claude/mirza-bots/fleetd.sock`);
    } finally {
      if (prev !== undefined) process.env.MIRZA_BOTS_HOME = prev;
    }
  });
});

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
