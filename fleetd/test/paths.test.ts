import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateRoot, ensureStateDirs, logsDir } from "../src/paths";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mirza-bots-paths-"));
  process.env.MIRZA_BOTS_HOME = tmp;
});

afterEach(() => {
  delete process.env.MIRZA_BOTS_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("paths", () => {
  test("stateRoot honors MIRZA_BOTS_HOME override", () => {
    expect(stateRoot()).toBe(tmp);
  });

  test("ensureStateDirs creates root, inbox, and logs dirs", () => {
    ensureStateDirs();
    expect(existsSync(tmp)).toBe(true);
    expect(existsSync(join(tmp, "inbox"))).toBe(true);
    expect(existsSync(logsDir())).toBe(true);
  });
});
