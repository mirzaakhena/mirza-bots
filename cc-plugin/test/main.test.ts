import { describe, test, expect } from "bun:test";
import { resolveSocketPath } from "../src/main";

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
