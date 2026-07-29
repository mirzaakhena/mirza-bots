import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, botCount, ConfigError } from "../src/config";

let tmp: string;
let cfgPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mirza-bots-config-"));
  cfgPath = join(tmp, "config.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("config", () => {
  test("loads a valid config and counts bots", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        allowFrom: ["123456"],
        bots: {
          "bot-01": { home: "/Users/mirza/Workspace/bot-01", token: "abc:def" },
          "bot-02": { home: "/Users/mirza/Workspace/bot-02", token: "ghi:jkl" },
        },
      })
    );
    const config = loadConfig(cfgPath);
    expect(botCount(config)).toBe(2);
    expect(config.allowFrom).toEqual(["123456"]);
  });

  test("rejects a bot entry missing the token field", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ allowFrom: ["1"], bots: { "bot-01": { home: "/x" } } })
    );
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
  });

  test("rejects malformed JSON", () => {
    writeFileSync(cfgPath, "{ not json");
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
  });

  test("rejects a missing file", () => {
    expect(() => loadConfig(join(tmp, "does-not-exist.json"))).toThrow(ConfigError);
  });

  test("rejects a config with an unrecognized top-level key", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        allowFrom: ["123456"],
        bots: { "bot-01": { home: "/Users/mirza/Workspace/bot-01", token: "abc:def" } },
        extraJunkField: true,
      })
    );
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
  });
});
