import { describe, test, expect } from "bun:test";
import { isAllowed } from "../../src/telegram/allowlist";
import type { Config } from "../../src/config";

const config: Config = {
  allowFrom: ["111", "222"],
  bots: { "bot-01": { home: "/tmp/bot-01", token: "t" } },
};

describe("allowlist", () => {
  test("allows a chat id present in allowFrom", () => {
    expect(isAllowed(config, "111")).toBe(true);
  });

  test("rejects a chat id absent from allowFrom", () => {
    expect(isAllowed(config, "999")).toBe(false);
  });

  test("rejects when allowFrom is empty", () => {
    expect(isAllowed({ ...config, allowFrom: [] }, "111")).toBe(false);
  });
});
